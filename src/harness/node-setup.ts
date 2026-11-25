import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { inject } from "vitest";

// Node's own `fetch` takes no options for trust, so the Node lane adds the host's certificate to
// the default certificates of each test worker.
setDefaultCACertificates([
  ...getCACertificates("default"),
  inject("certificate"),
]);
