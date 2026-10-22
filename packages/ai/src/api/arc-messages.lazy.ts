import { lazyApi } from "./lazy.ts";
export const arcMessagesApi = () => lazyApi(() => import("./arc-messages.ts"));
