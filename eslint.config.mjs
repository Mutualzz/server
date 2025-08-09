import config from "@mutualzz/eslint-config/base";

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
