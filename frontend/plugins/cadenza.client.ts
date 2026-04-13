import { defineNuxtPlugin } from "nuxt/app";
import Cadenza from "@cadenza.io/service";
import { defineCadenzaNuxtRuntimePlugin } from "@cadenza.io/service/nuxt";
import {
  createDemoFrontendCommands,
  createDemoFrontendSignalBindings,
} from "../lib/cadenza/runtime";

const setup = defineCadenzaNuxtRuntimePlugin({
  cadenza: Cadenza,
  actorName: "BrowserDemoFrontendRuntimeActor",
  hydrationStateKey: "demo-cadenza-hydration",
  service: {
    name: "DemoFrontend",
    description: "Nuxt demo frontend browser runtime.",
    useSocket: true,
    cadenzaDB: {
      connect: false,
    },
  },
  bootstrapUrl: (config) => String(config.public.cadenzaBootstrapUrl),
  initialProjectionState: {
    liveFeed: [],
  },
  signalBindings: createDemoFrontendSignalBindings(),
  commands: ({ runtime }) => createDemoFrontendCommands(runtime),
});

export default defineNuxtPlugin(setup);
