export { CodemodeSandboxDurableObject as Sandbox } from "@arc/codemode/cloudflare";

export default {
	fetch: () => new Response("Not found", { status: 404 }),
};
