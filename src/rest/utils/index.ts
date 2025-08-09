import express from "express";

export const createRouter = () => express.Router({ mergeParams: true });

export * from "./Constants";
