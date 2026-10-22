import { Editor, truncateToWidth, visibleWidth, type Component } from "@arc/tui";

export class AgentEditor extends Editor {
	#working: Component | undefined;
	setWorking(component: Component | undefined): void {
		this.#working = component;
	}
	protected override renderTopBorder(width: number, hidden: number): string {
		if (!this.#working || width < 6) return super.renderTopBorder(width, hidden);
		const label = hidden > 0 ? ` ↑ ${hidden} more ` : "";
		const labelWidth = visibleWidth(label);
		const center = Math.floor((width - labelWidth) / 2);
		const budget = hidden > 0 ? Math.max(1, center - 5) : width - 5;
		const text =
			this.#working
				.render(budget)
				.find((line) => visibleWidth(line.trim()) > 0)
				?.trim() ?? "";
		const status = truncateToWidth(text, budget, "");
		const size = visibleWidth(status);
		if (!size) return super.renderTopBorder(width, hidden);
		const lead = this.borderColor("── ") + status;
		if (labelWidth && center > size + 4)
			return (
				lead +
				this.borderColor(
					` ${"─".repeat(center - size - 4)}${label}${"─".repeat(Math.max(0, width - center - labelWidth))}`,
				)
			);
		return lead + this.borderColor(` ${"─".repeat(Math.max(0, width - size - 4))}`);
	}
}
