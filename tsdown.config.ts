import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["./src/**/*.ts"],
    clean: true,
    format: "esm",
    target: "esnext",
});
