import type { Model } from "@arc/ai";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@arc/durable/tools";
import type { UserInput } from "@arc/durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const inputContentSchema = Type.Union([
	Type.String(),
	Type.Array(
		Type.Union([
			Type.Object(
				{ type: Type.Literal("text"), text: Type.String(), textSignature: Type.Optional(Type.String()) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ type: Type.Literal("image"), data: Type.String({ minLength: 1 }), mimeType: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		]),
	),
]);

export function parseInput(value: unknown): UserInput {
	if (!Value.Check(inputContentSchema, value))
		throw new Error("Input must be text or an array of text and image blocks");
	if (typeof value === "string" ? !value.trim() : !value.some((block) => block.type === "image" || block.text.trim()))
		throw new Error("Input is empty");
	return value;
}

export async function prepareInput(
	input: UserInput,
	model: Model<string> | undefined,
	images: ImageProcessor,
): Promise<UserInput> {
	if (typeof input === "string") return input;
	const result: Exclude<UserInput, string> = [];
	for (const block of input) {
		if (block.type === "text") {
			result.push(block);
			continue;
		}
		const resize = model?.inputLimits?.images?.resize;
		const prepared = await images.prepare(Buffer.from(block.data, "base64"), block.mimeType, {
			maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
			maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
			maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
		});
		if (!prepared) throw new Error("Cannot decode or prepare attached image");
		if (prepared.resized) {
			const { from, to } = prepared.resized;
			result.push({
				type: "text",
				text: `Image resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${(from.width / to.width).toFixed(2)} to map to the original.`,
			});
		}
		result.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
	}
	return result;
}
