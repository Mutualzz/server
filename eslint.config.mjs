import { base as config } from "@mutualzz/eslint-config";

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
];
