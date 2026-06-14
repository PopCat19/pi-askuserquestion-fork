declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		on(event: string, handler: (...args: any[]) => any): void;
		registerTool(tool: any): void;
		registerCommand(name: string, command: any): void;
	}
}

declare module "@earendil-works/pi-tui" {
	export class Text {
		constructor(text: string, x?: number, y?: number);
		setText(text: string): void;
	}
}
