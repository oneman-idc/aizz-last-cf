import { handleRequest } from "../../src/api";
import type { Env } from "../../src/types";

export const onRequest: PagesFunction<Env> = async (context) => {
  return handleRequest(context.request, context.env, (promise) => context.waitUntil(promise));
};
