export default defineNuxtConfig({
  compatibilityDate: "2026-03-14",
  devtools: {
    enabled: false,
  },
  css: ["~/assets/css/main.css"],
  runtimeConfig: {
    cadenzaServerAddress: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
    cadenzaServerPort: Number.parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    public: {
      cadenzaBootstrapUrl:
        process.env.NUXT_PUBLIC_CADENZA_BOOTSTRAP_URL ??
        "http://cadenza-db.localhost:80",
      appOrigin:
        process.env.NUXT_PUBLIC_APP_ORIGIN ?? "http://frontend.localhost",
    },
  },
  app: {
    head: {
      title: "Cadenza Demo 2",
      meta: [
        {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        },
        {
          name: "description",
          content:
            "Operational frontend for the Cadenza Demo 2 IoT system using direct browser connectivity.",
        },
      ],
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
});
