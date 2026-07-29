import { base as config } from "@mutualzz/eslint-config";

export default [
    {
        ignores: ["dist/**", "node_modules/**", "eslint.config.mjs"],
    },
    ...config,
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
];
