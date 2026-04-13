import http from "node:http";
import httpProxy from "http-proxy";

const routes = {
  "frontend.localhost": "http://frontend:3000",
  "console.localhost": "http://cadenza-ui:3000",
  "cadenza-db.localhost": "http://cadenza-db-service:8080",
  "iot-db.localhost": "http://iot-db-service:3001",
  "telemetry-collector.localhost": "http://telemetry-collector:3003",
  "telemetry-collector-b.localhost": "http://telemetry-collector-b:3003",
  "anomaly-detector.localhost": "http://anomaly-detector:3004",
  "predictor.localhost": "http://predictor:3005",
  "alert-service.localhost": "http://alert-service:3006",
};

const proxy = httpProxy.createProxyServer({
  xfwd: true,
  ws: true,
});

function resolveTarget(req) {
  const hostHeader = String(req.headers.host ?? "").trim();
  const host = hostHeader.split(":")[0];
  return routes[host] ?? null;
}

function writeBadGateway(res, message) {
  res.writeHead(502, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(message);
}

proxy.on("error", (error, req, res) => {
  const message = `Reverse proxy error for ${String(req.headers.host ?? "unknown host")}: ${
    error.message
  }`;

  if (res && "writeHead" in res) {
    writeBadGateway(res, message);
  }
});

const server = http.createServer((req, res) => {
  const target = resolveTarget(req);

  if (!target) {
    writeBadGateway(
      res,
      `No reverse proxy route configured for ${String(req.headers.host ?? "unknown host")}.`,
    );
    return;
  }

  proxy.web(req, res, {
    target,
    changeOrigin: false,
  });
});

server.on("upgrade", (req, socket, head) => {
  const target = resolveTarget(req);

  if (!target) {
    socket.destroy();
    return;
  }

  proxy.ws(req, socket, head, {
    target,
    changeOrigin: false,
  });
});

server.listen(80, () => {
  console.log("Edge proxy listening on port 80");
});
