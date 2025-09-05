import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/**/**/*"],
    clean: true,
    format: "esm",
    target: "esnext",
});
