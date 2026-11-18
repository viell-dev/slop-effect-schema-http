import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

const allowances = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    range: "<=4.0.7",
    reason:
      "Development and documentation tooling only. No patched release exists.",
    issue: "https://github.com/viell-dev/slop-effect-schema-http/issues/41",
    removal:
      "Adopt a patched picomatch and remove this allowance as soon as a fix is available.",
  },
];

const severityLevels = ["info", "low", "moderate", "high", "critical"];
const level = (severity) => severityLevels.indexOf(severity);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;
const hasFix = (fix) => fix === true || fix?.isSemVerMajor === false;

function readAudit({ status, stdout }, scope) {
  const malformed = () => {
    throw new Error(
      `${scope} npm audit returned malformed or unsuccessful output (exit ${status}). Check npm and registry access, then rerun.`,
    );
  };
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    malformed();
  }
  if (
    report?.auditReportVersion !== 2 ||
    report.error !== undefined ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata?.vulnerabilities)
  )
    malformed();

  const packages = new Map(Object.entries(report.vulnerabilities));
  const causes = [];
  const dependents = new Map([...packages.keys()].map((name) => [name, []]));
  const counts = severityLevels.map(() => 0);
  for (const [name, finding] of packages) {
    if (
      finding?.name !== name ||
      level(finding.severity) === -1 ||
      !Array.isArray(finding.via) ||
      finding.via.length === 0
    )
      malformed();
    const fix = finding.fixAvailable;
    if (
      typeof fix !== "boolean" &&
      !(
        isRecord(fix) &&
        isText(fix.name) &&
        isText(fix.version) &&
        typeof fix.isSemVerMajor === "boolean"
      )
    )
      malformed();
    counts[level(finding.severity)]++;

    // npm uses advisory objects at the source and package names for transitive findings.
    for (const via of finding.via) {
      if (typeof via === "string" && dependents.has(via)) {
        dependents.get(via).push(name);
      } else if (
        via?.name === name &&
        via.dependency === name &&
        isText(via.range) &&
        isText(via.url) &&
        level(via.severity) !== -1
      ) {
        causes.push(via);
      } else {
        malformed();
      }
    }
  }

  const summary = report.metadata.vulnerabilities;
  if (
    summary.total !== packages.size ||
    severityLevels.some(
      (severity, index) => summary[severity] !== counts[index],
    ) ||
    status !== Number(counts.slice(level("moderate")).some(Boolean))
  )
    malformed();

  const covered = new Set();
  const advisories = causes.map((cause) => {
    // Walk outward from the advisory. The set also terminates dependency cycles.
    const affected = new Set([cause.name]);
    for (const name of affected) {
      for (const dependent of dependents.get(name)) affected.add(dependent);
      if (level(cause.severity) >= level(packages.get(name).severity))
        covered.add(name);
    }
    return {
      id:
        /^https:\/\/github\.com\/advisories\/(GHSA-[\w-]+)$/.exec(
          cause.url,
        )?.[1] ?? cause.url,
      package: cause.name,
      range: cause.range,
      severity: cause.severity,
      packages: [...affected].toSorted(),
      fixAvailable: [...affected].some((name) =>
        hasFix(packages.get(name).fixAvailable),
      ),
    };
  });
  if (covered.size !== packages.size) malformed();
  return { advisories, packageCount: packages.size };
}

const describe = (finding) =>
  `${finding.id} ${finding.package} ${finding.range} (${finding.severity}). Affected packages: ${finding.packages.join(", ")}.`;

export function checkAuditReport(result, scope, allowed = allowances) {
  const { advisories, packageCount } = readAudit(result, scope);
  if (scope === "Production") {
    if (advisories.length)
      throw new Error(
        `Production dependency audit refused:\n${advisories.map(describe).join("\n")}\nUpdate or remove the affected dependencies and rerun. Production has no allowances.`,
      );
    return "Production dependency audit passed (0 findings).";
  }

  const findings = advisories.filter(
    (finding) => level(finding.severity) >= level("moderate"),
  );
  const seen = new Set();
  const failures = [];
  for (const finding of findings) {
    const entry = allowed.find(
      (allowance) =>
        allowance.id === finding.id &&
        allowance.package === finding.package &&
        allowance.range === finding.range,
    );
    if (!entry) {
      failures.push(
        `${describe(finding)} Update or remove the affected dependencies.`,
      );
    } else {
      seen.add(entry);
      if (finding.fixAvailable)
        failures.push(
          `${describe(finding)} npm now reports a compatible fix. ${entry.removal} ${entry.issue}`,
        );
    }
  }
  for (const entry of allowed) {
    if (!seen.has(entry))
      failures.push(
        `Stale allowance for ${entry.id} ${entry.package} ${entry.range}: no matching moderate-or-higher finding. Adopt any available fix and remove the allowance. ${entry.issue}`,
      );
  }
  if (failures.length)
    throw new Error(`Full dependency audit refused:\n${failures.join("\n")}`);

  const summary = `Full dependency audit passed (${packageCount} package findings, ${seen.size} ${seen.size === 1 ? "advisory" : "advisories"} allowed).`;
  return [
    summary,
    ...[...seen].map(
      (entry) =>
        `Allowed ${entry.id} ${entry.package} ${entry.range}. ${entry.reason} ${entry.issue}`,
    ),
  ].join("\n");
}

export function checkReleaseAudit(npm, allowed = allowances) {
  const run = (scope, args) => {
    const result = spawnSync(
      process.execPath,
      [
        npm,
        "audit",
        "--json",
        "--audit-level=moderate",
        "--package-lock-only",
        "--include=prod",
        "--include=optional",
        "--include=peer",
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    if (result.error) throw result.error;
    console.log(checkAuditReport(result, scope, allowed));
  };
  run("Production", ["--omit=dev"]);
  run("Full", ["--include=dev"]);
}
