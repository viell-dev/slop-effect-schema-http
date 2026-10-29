// Record HTTP exchanges with real server software, byte for byte, in a disposable Docker container.
// Run on demand, never in CI: `npm run record -- <set>`. recordings/README.md describes the sets,
// the files this writes and how the tests use them.
//
// For `recordings/<set>/`, the script:
//
// 1. builds the set's Dockerfile into the image `hostile-recording-<set>` and starts it as the
//    container `hostile-recording-<set>`, publishing the server's port on an ephemeral loopback
//    port; a leftover container of that name, from an interrupted run, is removed first;
// 2. waits until the server answers a probe request with an HTTP status line;
// 3. records the software versions with the commands `set.json` names;
// 4. performs the exchanges `set.json` lists, in order: a raw request from this process over a
//    plain TCP socket, the exact bytes of an earlier exchange's request sent again, or a curl
//    command run in its own container, which reaches the server through a relay in this process
//    that keeps the bytes of every connection;
// 5. writes each exchange as `<name>.request.http` and `<name>.response.http`, exactly as the bytes
//    crossed the connection, removes `.http` files of exchanges no longer listed, and writes
//    `manifest.json` with the images, versions, date and every command run;
// 6. removes the container, whether or not the recording succeeded. The image is kept as a build
//    cache; `docker image rm hostile-recording-<set>` removes it.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = fileURLToPath(new URL("..", import.meta.url));
const set = process.argv[2];
if (set === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(set)) {
  const sets = readdirSync(join(root, "recordings"), { withFileTypes: true })
    .filter((entry) =>
      existsSync(join(root, "recordings", entry.name, "set.json")),
    )
    .map((entry) => entry.name);
  console.error(`usage: npm run record -- <set>\nsets: ${sets.join(", ")}`);
  process.exit(2);
}
const directory = join(root, "recordings", set);
if (!existsSync(join(directory, "set.json"))) {
  console.error(`recordings/${set}/set.json does not exist`);
  process.exit(2);
}
const definition = JSON.parse(
  readFileSync(join(directory, "set.json"), "utf8"),
);
const name = `hostile-recording-${set}`;

/** Every command run, as recorded in the manifest. */
const commands = [];

/** Run docker with arguments; fails unless `allowFailure`. Returns trimmed stdout and stderr. */
const docker = (args, { allowFailure = false, log = true } = {}) => {
  if (log) commands.push(["docker", ...args].join(" "));
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `docker ${args.join(" ")} failed (${result.status}):\n${result.stderr}`,
    );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
};

/**
 * Run docker without blocking this process, for a container that talks to the relay below, which
 * needs the event loop while docker runs.
 */
const dockerAsync = (args) => {
  commands.push(["docker", ...args].join(" "));
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (status) =>
      status === 0
        ? resolve()
        : reject(
            new Error(
              `docker ${args.join(" ")} failed (${status}):\n${Buffer.concat(errors)}`,
            ),
          ),
    );
  });
};

const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

/** The header fields of a message head, names lower-cased. */
const fields = (head) =>
  head
    .split("\r\n")
    .slice(1)
    .map((line) => {
      const colon = line.indexOf(":");
      return [
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      ];
    });

/**
 * The length of the complete HTTP/1.1 message at the start of `bytes`, or undefined while it is
 * incomplete. A response without `Content-Length` or chunked framing ends when the server closes.
 */
const messageLength = (bytes, { request, method = "GET", closed = false }) => {
  const end = bytes.indexOf(HEAD_END);
  if (end < 0) return undefined;
  const head = bytes.subarray(0, end).toString("latin1");
  const headers = fields(head);
  const bodyStart = end + HEAD_END.length;
  if (!request) {
    const status = Number(head.split(" ")[1]);
    if (method === "HEAD" || status === 204 || status === 304 || status < 200)
      return bodyStart;
  }
  const encoding = headers.find(([field]) => field === "transfer-encoding");
  if (encoding !== undefined && /chunked/i.test(encoding[1])) {
    let at = bodyStart;
    for (;;) {
      const line = bytes.indexOf(CRLF, at);
      if (line < 0) return undefined;
      const size = Number.parseInt(
        bytes.subarray(at, line).toString("latin1").split(";")[0],
        16,
      );
      if (Number.isNaN(size)) throw new Error("malformed chunk size");
      at = line + CRLF.length;
      if (size === 0)
        for (;;) {
          const trailer = bytes.indexOf(CRLF, at);
          if (trailer < 0) return undefined;
          if (trailer === at) return trailer + CRLF.length;
          at = trailer + CRLF.length;
        }
      if (bytes.length < at + size + CRLF.length) return undefined;
      at += size + CRLF.length;
    }
  }
  const length = headers.find(([field]) => field === "content-length");
  if (length !== undefined) {
    const total = bodyStart + Number(length[1]);
    return bytes.length >= total ? total : undefined;
  }
  if (request) return bodyStart;
  return closed ? bytes.length : undefined;
};

/** A request's bytes: the request line, Host, the given lines, Content-Length, Connection: close. */
const requestBytes = (request) => {
  const body = Buffer.from(request.body ?? "", "utf8");
  const lines = [
    ["Host", definition.host],
    ...(request.headers ?? []),
    ...(request.body === undefined
      ? []
      : [["Content-Length", String(body.length)]]),
    ["Connection", "close"],
  ];
  return Buffer.concat([
    Buffer.from(
      `${request.method} ${request.target} HTTP/1.1\r\n${lines
        .map(([field, value]) => `${field}: ${value}\r\n`)
        .join("")}\r\n`,
      "latin1",
    ),
    body,
  ]);
};

/**
 * Send `bytes` over a new connection to the published port and read the reply until the server
 * closes, or until the reply is complete and the server has had a moment to close.
 */
const exchange = (port, bytes, method) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let settle;
    const socket = connect({ host: "127.0.0.1", port }, () =>
      socket.write(bytes),
    );
    const finish = () => {
      clearTimeout(timeout);
      clearTimeout(settle);
      socket.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("no complete reply within 30 seconds"));
    }, 30_000);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      if (
        settle === undefined &&
        messageLength(received, { request: false, method }) !== undefined
      )
        settle = setTimeout(finish, 1_000);
    });
    socket.on("end", finish);
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

/**
 * A relay on a loopback port that forwards each connection to the published port and keeps both
 * directions' bytes exactly as they crossed it. curl reaches it through Docker's
 * `host.docker.internal`; its own `--trace` cannot serve, because curl leaves out the body of a 401 it
 * reads while negotiating Digest. `RECORD_RELAY_HOST` changes the address it listens on, for a
 * Docker engine whose containers cannot reach the host's loopback interface.
 */
const startRelay = (port) =>
  new Promise((resolve) => {
    const connections = [];
    const server = createServer((client) => {
      const record = { client: [], server: [] };
      connections.push(record);
      const upstream = connect({ host: "127.0.0.1", port });
      client.on("data", (chunk) => {
        record.client.push(chunk);
        upstream.write(chunk);
      });
      upstream.on("data", (chunk) => {
        record.server.push(chunk);
        client.write(chunk);
      });
      client.on("end", () => upstream.end());
      upstream.on("end", () => client.end());
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    server.listen(0, process.env.RECORD_RELAY_HOST ?? "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        connections,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });

/** Split one connection's two directions into exchanges, pairing requests and responses in order. */
const splitConnection = ({ client, server }) => {
  let requests = Buffer.concat(client);
  let responses = Buffer.concat(server);
  const exchanges = [];
  while (requests.length > 0) {
    const requestEnd = messageLength(requests, { request: true });
    if (requestEnd === undefined) throw new Error("an incomplete request");
    const request = requests.subarray(0, requestEnd);
    const { method } = requestLine(request);
    const responseEnd = messageLength(responses, {
      request: false,
      method,
      closed: requestEnd === requests.length,
    });
    if (responseEnd === undefined) throw new Error("an incomplete response");
    exchanges.push({ request, response: responses.subarray(0, responseEnd) });
    requests = requests.subarray(requestEnd);
    responses = responses.subarray(responseEnd);
  }
  if (responses.length > 0) throw new Error("a response without a request");
  return exchanges;
};

const requestLine = (bytes) => {
  const line = bytes.subarray(0, bytes.indexOf(CRLF)).toString("latin1");
  const [method, target] = line.split(" ");
  return { method, target };
};

const statusLine = (bytes) =>
  bytes.subarray(0, bytes.indexOf(CRLF)).toString("latin1");

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const cleanUp = () => {
  for (const container of [name, `${name}-curl`])
    docker(["rm", "-f", container], { allowFailure: true, log: false });
};

const record = async () => {
  const recorded = new Date();
  cleanUp();
  docker(["build", "-t", name, `recordings/${set}`]);
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1::${definition.port}`,
    name,
  ]);
  const published = docker(["port", name, `${definition.port}/tcp`])
    .stdout.split("\n")
    .find((line) => line.startsWith("127.0.0.1:"));
  if (published === undefined) throw new Error("the port was not published");
  const port = Number(published.split(":")[1]);

  // The server is ready once it answers the probe with a status line; Docker's port proxy accepts
  // connections before the server listens, so a successful connection alone proves nothing.
  const probe = requestBytes(definition.probe);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const reply = await exchange(port, probe, definition.probe.method).catch(
      () => Buffer.alloc(0),
    );
    if (reply.subarray(0, 5).toString("latin1") === "HTTP/") break;
    if (Date.now() > deadline) {
      console.error(
        docker(["logs", name], { allowFailure: true, log: false }).stderr,
      );
      throw new Error("the server did not answer within three minutes");
    }
    await sleep(1_000);
  }

  const versions = {};
  for (const [label, command] of Object.entries(definition.versions)) {
    const result =
      command[0] === "curl"
        ? docker(["run", "--rm", definition.curl, ...command.slice(1)])
        : docker(["exec", name, ...command]);
    versions[label] = [result.stdout, result.stderr]
      .filter((text) => text !== "")
      .join("\n")
      .split("\n")
      .map((text) => text.trimEnd());
  }

  const results = [];
  const byName = new Map();
  for (const step of definition.exchanges) {
    if (step.wait !== undefined) await sleep(step.wait * 1_000);
    let produced;
    if (step.request !== undefined || step.repeat !== undefined) {
      const request =
        step.request === undefined
          ? byName.get(step.repeat)?.request
          : requestBytes(step.request);
      if (request === undefined)
        throw new Error(
          `${step.name} repeats an unknown exchange ${step.repeat}`,
        );
      const response = await exchange(
        port,
        request,
        requestLine(request).method,
      );
      produced = [{ ...step, request, response }];
    } else if (step.curl !== undefined) {
      const relay = await startRelay(port);
      const url = new URL(step.curl.at(-1));
      await dockerAsync([
        "run",
        "--rm",
        "--name",
        `${name}-curl`,
        "--add-host",
        "host.docker.internal:host-gateway",
        definition.curl,
        "--silent",
        "--show-error",
        "--output",
        "/dev/null",
        "--connect-to",
        `${url.hostname}:${url.port || 80}:host.docker.internal:${relay.port}`,
        ...step.curl,
      ]);
      await relay.close();
      const found = relay.connections.flatMap(splitConnection);
      if (found.length !== step.names.length)
        throw new Error(
          `curl made ${found.length} exchanges where ${step.names.length} were named`,
        );
      produced = found.map((pair, index) => ({
        ...step,
        name: step.names[index],
        description: step.descriptions[index],
        ...pair,
      }));
    } else throw new Error(`exchange step without request, repeat or curl`);
    for (const item of produced) {
      const { method, target } = requestLine(item.request);
      if (
        messageLength(item.request, { request: true }) !== item.request.length
      )
        throw new Error(
          `${item.name}: the request is not one complete message`,
        );
      if (
        messageLength(item.response, {
          request: false,
          method,
          closed: true,
        }) !== item.response.length
      )
        throw new Error(
          `${item.name}: the response is not one complete message`,
        );
      byName.set(item.name, item);
      results.push({
        ...item,
        method,
        target,
        status: statusLine(item.response),
      });
    }
  }

  for (const file of readdirSync(directory))
    if (file.endsWith(".http")) rmSync(join(directory, file));
  for (const item of results) {
    writeFileSync(join(directory, `${item.name}.request.http`), item.request);
    writeFileSync(join(directory, `${item.name}.response.http`), item.response);
  }

  const images = [
    ...readFileSync(join(directory, "Dockerfile"), "utf8").matchAll(
      /^FROM\s+(\S+)/gim,
    ),
  ].map((match) => match[1]);
  if (results.some((item) => item.curl !== undefined))
    images.push(definition.curl);
  const manifest = {
    set,
    description: definition.description,
    recorded: recorded.toISOString(),
    images,
    built: docker(["image", "inspect", "--format", "{{.Id}}", name], {
      log: false,
    }).stdout,
    versions,
    substitutions: definition.substitutions ?? [],
    client: definition.client,
    commands,
    exchanges: results.map((item) => ({
      name: item.name,
      description: item.description,
      method: item.method,
      target: item.target,
      status: item.status,
      request: `${item.name}.request.http`,
      response: `${item.name}.response.http`,
    })),
  };
  writeFileSync(
    join(directory, "manifest.json"),
    await format(JSON.stringify(manifest), { parser: "json" }),
  );
  for (const item of results)
    console.log(
      `${item.name}: ${item.method} ${item.target} -> ${item.status}`,
    );
};

try {
  await record();
} finally {
  cleanUp();
}
