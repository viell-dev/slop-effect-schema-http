// Express owns callback selection, sanitization, framing and response headers. The probe supplies
// only the service-shaped synthetic payload; it has no CDN cache or callback validator.
import { readFileSync } from "node:fs";
import express from "express";

const rates = JSON.parse(
  readFileSync(new URL("./data.json", import.meta.url), "utf8"),
);
const app = express();
app.get("/v1/rates", (_request, response) => response.jsonp(rates));
app.listen(8080, "0.0.0.0");
