import Cadenza from "@cadenza.io/service";
import { iotHealthSchema } from "./schema.js";

const publicOrigin =
  process.env.PUBLIC_ORIGIN ?? "http://iot-db.localhost";
const internalOrigin = `http://${process.env.CADENZA_SERVER_URL ?? "iot-db-service"}:${
  process.env.HTTP_PORT ?? "3001"
}`;

Cadenza.createDatabaseService("IotDbService", iotHealthSchema as any, "IoT Database Service", {
  useSocket: false,
  cadenzaDB: {
    connect: true,
    address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
    port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
  },
  transports: [
    {
      role: "internal",
      origin: internalOrigin,
      protocols: ["rest"],
    },
    {
      role: "public",
      origin: publicOrigin,
      protocols: ["rest"],
    },
  ],
});
