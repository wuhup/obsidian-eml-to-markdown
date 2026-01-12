import { App, PluginSettingTab, Setting } from 'obsidian';
import type EmlToMarkdownPlugin from './main';

export type EmlHandling = 'keep' | 'delete' | 'move-to-attachments';
export type AttachmentListPosition = 'top' | 'bottom' | 'both';

export interface EmlToMarkdownSettings {
	autoConvert: boolean;
	emlHandling: EmlHandling;
	linkMovedEml: boolean;
	useFrontmatter: boolean;
	dateFormat: string;
	showHeadersInBody: boolean;
	attachmentListPosition: AttachmentListPosition;
}

export const DEFAULT_SETTINGS: EmlToMarkdownSettings = {
	autoConvert: true,
	emlHandling: 'move-to-attachments',
	linkMovedEml: true,
	useFrontmatter: true,
	dateFormat: 'YYYY-MM-DD HH:mm',
	showHeadersInBody: true,
	attachmentListPosition: 'both'
};

export class EmlToMarkdownSettingTab extends PluginSettingTab {
	plugin: EmlToMarkdownPlugin;

	constructor(app: App, plugin: EmlToMarkdownPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Auto-convert')
			.setDesc('Automatically convert .eml files when they are added to the vault.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoConvert)
				.onChange(async (value) => {
					this.plugin.settings.autoConvert = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('EML file handling')
			.setDesc('What to do with the original .eml file after conversion.')
			.addDropdown(dropdown => dropdown
				.addOption('keep', 'Keep in place')
				.addOption('delete', 'Delete')
				.addOption('move-to-attachments', 'Move to attachments folder')
				.setValue(this.plugin.settings.emlHandling)
				.onChange(async (value: EmlHandling) => {
					this.plugin.settings.emlHandling = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide link option
				}));

		if (this.plugin.settings.emlHandling === 'move-to-attachments') {
			new Setting(containerEl)
				.setName('Link moved EML')
				.setDesc('Include a link to the moved .eml file in the generated Markdown.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.linkMovedEml)
					.onChange(async (value) => {
						this.plugin.settings.linkMovedEml = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Use frontmatter')
			.setDesc('Include email metadata as YAML frontmatter in the generated Markdown file.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useFrontmatter)
				.onChange(async (value) => {
					this.plugin.settings.useFrontmatter = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show headers in body')
			.setDesc('Display From/To/Date headers in the note body in addition to frontmatter.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showHeadersInBody)
				.onChange(async (value) => {
					this.plugin.settings.showHeadersInBody = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Attachment list position')
			.setDesc('Where to show the list of attachments in the generated note.')
			.addDropdown(dropdown => dropdown
				.addOption('top', 'Top (after headers)')
				.addOption('bottom', 'Bottom (after body)')
				.addOption('both', 'Both top and bottom')
				.setValue(this.plugin.settings.attachmentListPosition)
				.onChange(async (value: AttachmentListPosition) => {
					this.plugin.settings.attachmentListPosition = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Format for displaying dates. Use YYYY for year, MM for month, DD for day, HH for hour, mm for minute.')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD HH:mm')
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value || DEFAULT_SETTINGS.dateFormat;
					await this.plugin.saveSettings();
				}));
	}
}
