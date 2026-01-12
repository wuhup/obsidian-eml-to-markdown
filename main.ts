import {
	Plugin,
	TFile,
	TAbstractFile,
	Notice,
	normalizePath
} from 'obsidian';
import {
	parseEml,
	ParsedEmail,
	formatEmailAddresses,
	htmlToMarkdown
} from './eml-parser';
import {
	EmlToMarkdownSettings,
	DEFAULT_SETTINGS,
	EmlToMarkdownSettingTab
} from './settings';

// Maximum attachment size in bytes (500 MB)
const MAX_ATTACHMENT_SIZE = 500 * 1024 * 1024;

export default class EmlToMarkdownPlugin extends Plugin {
	settings: EmlToMarkdownSettings;
	// Track files currently being processed to prevent loops
	private processingFiles: Set<string> = new Set();

	async onload() {
		await this.loadSettings();

		// Register file watcher for .eml files
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (this.settings.autoConvert && file instanceof TFile && file.extension === 'eml') {
					// Skip if already processing or in attachments folder
					if (this.processingFiles.has(file.path) || this.isInAttachmentsFolder(file)) {
						return;
					}
					// Small delay to ensure file is fully written
					setTimeout(() => this.convertEmlFile(file), 500);
				}
			})
		);

		// Watch for renames - but only if renamed TO .eml (not moved within vault)
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (this.settings.autoConvert && file instanceof TFile && file.extension === 'eml') {
					// Skip if: already processing, in attachments folder, or was already .eml (just moved)
					const wasEml = oldPath.toLowerCase().endsWith('.eml');
					if (this.processingFiles.has(file.path) || this.isInAttachmentsFolder(file) || wasEml) {
						return;
					}
					setTimeout(() => this.convertEmlFile(file), 500);
				}
			})
		);

		// Add command to manually convert selected EML file
		this.addCommand({
			id: 'convert-eml-to-markdown',
			name: 'Convert EML file to Markdown',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'eml') {
					if (!checking) {
						this.convertEmlFile(activeFile);
					}
					return true;
				}
				return false;
			}
		});

		// Add command to convert all EML files in vault
		this.addCommand({
			id: 'convert-all-eml-to-markdown',
			name: 'Convert all EML files in vault to Markdown',
			callback: async () => {
				const emlFiles = this.app.vault.getFiles().filter(f => f.extension === 'eml');
				if (emlFiles.length === 0) {
					new Notice('No .eml files found in vault');
					return;
				}

				new Notice(`Converting ${emlFiles.length} EML file(s)...`);
				let converted = 0;
				let failed = 0;

				for (const file of emlFiles) {
					try {
						await this.convertEmlFile(file);
						converted++;
					} catch (e) {
						failed++;
						console.error(`EML conversion failed for ${file.path}:`, e);
					}
				}

				new Notice(`Converted ${converted} EML file(s). ${failed > 0 ? `${failed} failed.` : ''}`);
			}
		});

		// Settings tab
		this.addSettingTab(new EmlToMarkdownSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Get the attachment folder path based on Obsidian settings
	 */
	getAttachmentFolder(sourceFile: TFile): string {
		// @ts-ignore - accessing internal API for attachment folder
		const attachmentFolderPath = this.app.vault.getConfig('attachmentFolderPath');

		if (!attachmentFolderPath || attachmentFolderPath === '/') {
			// Root of vault
			return '';
		}

		if (attachmentFolderPath.startsWith('./')) {
			// Relative to current file
			const folder = sourceFile.parent;
			return folder ? normalizePath(folder.path + '/' + attachmentFolderPath.substring(2)) : attachmentFolderPath.substring(2);
		}

		// Absolute path in vault
		return attachmentFolderPath;
	}

	/**
	 * Check if a file is in an attachments folder
	 */
	isInAttachmentsFolder(file: TFile): boolean {
		// @ts-ignore - accessing internal API for attachment folder
		const attachmentFolderPath = this.app.vault.getConfig('attachmentFolderPath');

		if (!attachmentFolderPath || attachmentFolderPath === '/') {
			return false;
		}

		if (attachmentFolderPath.startsWith('./')) {
			// Relative attachments folder - check if file is in any "attachments" subfolder
			const folderName = attachmentFolderPath.substring(2);
			return file.path.includes('/' + folderName + '/') || file.path.startsWith(folderName + '/');
		}

		// Absolute attachments folder
		return file.path.startsWith(attachmentFolderPath + '/') || file.path.startsWith(attachmentFolderPath);
	}

	/**
	 * Ensure a folder exists, creating it and any parent folders if necessary
	 */
	async ensureFolderExists(folderPath: string): Promise<void> {
		if (!folderPath) return;

		const normalizedPath = normalizePath(folderPath);
		const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (folder) return;

		// Create parent folders recursively
		const parts = normalizedPath.split('/');
		let currentPath = '';

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existingFolder = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existingFolder) {
				try {
					await this.app.vault.createFolder(currentPath);
				} catch (e) {
					// Folder may have been created concurrently, ignore if it exists now
					if (!this.app.vault.getAbstractFileByPath(currentPath)) {
						throw e;
					}
				}
			}
		}
	}

	/**
	 * Convert an EML file to Markdown
	 */
	async convertEmlFile(file: TFile): Promise<void> {
		// Prevent concurrent processing of the same file
		if (this.processingFiles.has(file.path)) {
			return;
		}

		// Mark as processing
		this.processingFiles.add(file.path);

		try {
			// Check if markdown file already exists
			const mdPath = file.path.replace(/\.eml$/i, '.md');
			const existingMd = this.app.vault.getAbstractFileByPath(mdPath);
			if (existingMd) {
				// Markdown already exists, skip
				return;
			}

			// Skip files already in attachments folder
			if (this.isInAttachmentsFolder(file)) {
				return;
			}

			// Read EML file using Vault API
			const emlContent = await this.app.vault.read(file);

			// Parse EML
			const email = parseEml(emlContent);

			// Get attachment folder (for both attachments and moved EML)
			const attachmentFolder = this.getAttachmentFolder(file);

			// Save attachments
			const attachmentLinks = await this.saveAttachments(email, file, attachmentFolder);

			// Handle EML file based on settings
			let movedEmlName: string | null = null;
			if (this.settings.emlHandling === 'move-to-attachments') {
				movedEmlName = await this.moveEmlToAttachments(file, attachmentFolder);
			}

			// Generate Markdown
			const markdown = this.generateMarkdown(email, attachmentLinks, movedEmlName);

			// Create Markdown file
			await this.app.vault.create(mdPath, markdown);

			// Handle original EML file (delete case)
			if (this.settings.emlHandling === 'delete') {
				await this.app.vault.delete(file);
			}
			// move-to-attachments case is already handled above

			new Notice(`Converted: ${file.name}`);
		} catch (error) {
			console.error('EML conversion error:', error);
			new Notice(`Failed to convert ${file.name}: ${(error as Error).message}`);
		} finally {
			// Always remove from processing set
			this.processingFiles.delete(file.path);
		}
	}

	/**
	 * Move the EML file to the attachments folder
	 */
	async moveEmlToAttachments(file: TFile, attachmentFolder: string): Promise<string> {
		// Ensure attachment folder exists
		await this.ensureFolderExists(attachmentFolder);

		// Create unique filename if needed
		const baseName = file.basename;
		let newName = file.name;
		let newPath = attachmentFolder
			? normalizePath(`${attachmentFolder}/${newName}`)
			: newName;

		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(newPath)) {
			newName = `${baseName}_${counter}.eml`;
			newPath = attachmentFolder
				? normalizePath(`${attachmentFolder}/${newName}`)
				: newName;
			counter++;
		}

		// Move the file using FileManager (updates links automatically)
		await this.app.fileManager.renameFile(file, newPath);

		return newName;
	}

	/**
	 * Save attachments to the attachment folder using Vault API
	 */
	async saveAttachments(
		email: ParsedEmail,
		sourceFile: TFile,
		attachmentFolder: string
	): Promise<Map<string, string>> {
		const attachmentLinks = new Map<string, string>();

		if (email.attachments.length === 0) {
			return attachmentLinks;
		}

		// Ensure attachment folder exists
		await this.ensureFolderExists(attachmentFolder);

		const baseName = sourceFile.basename;

		for (const attachment of email.attachments) {
			try {
				// Skip attachments over size limit
				if (attachment.content.length > MAX_ATTACHMENT_SIZE) {
					continue;
				}

				// Create safe filename
				const safeName = this.sanitizeFilename(attachment.filename);
				const attachmentName = `${baseName}_${safeName}`;
				const attachmentPath = attachmentFolder
					? normalizePath(`${attachmentFolder}/${attachmentName}`)
					: attachmentName;

				// Check if file already exists
				if (this.app.vault.getAbstractFileByPath(attachmentPath)) {
					// File exists, just add the link
					attachmentLinks.set(attachment.filename, attachmentName);
					if (attachment.contentId) {
						attachmentLinks.set(`cid:${attachment.contentId}`, attachmentName);
					}
					continue;
				}

				// Write attachment using Vault API (binary)
				await this.app.vault.createBinary(attachmentPath, attachment.content);

				// Store link for markdown generation
				attachmentLinks.set(attachment.filename, attachmentName);

				// Also store by content-id for inline images
				if (attachment.contentId) {
					attachmentLinks.set(`cid:${attachment.contentId}`, attachmentName);
				}
			} catch (error) {
				console.error(`Attachment save failed for ${attachment.filename}:`, error);
			}
		}

		return attachmentLinks;
	}

	/**
	 * Sanitize filename for safe file system use
	 */
	sanitizeFilename(filename: string): string {
		return filename
			.replace(/[<>:"/\\|?*]/g, '_')
			.replace(/\s+/g, '_')
			.replace(/_+/g, '_')
			.substring(0, 200); // Limit length
	}

	/**
	 * Format date according to settings
	 */
	formatDate(date: Date | null): string {
		if (!date || isNaN(date.getTime())) {
			return '';
		}

		const format = this.settings.dateFormat;

		const pad = (n: number) => n.toString().padStart(2, '0');

		return format
			.replace('YYYY', date.getFullYear().toString())
			.replace('MM', pad(date.getMonth() + 1))
			.replace('DD', pad(date.getDate()))
			.replace('HH', pad(date.getHours()))
			.replace('mm', pad(date.getMinutes()))
			.replace('ss', pad(date.getSeconds()));
	}

	/**
	 * Format date as ISO string for frontmatter
	 */
	formatDateISO(date: Date | null): string {
		if (!date || isNaN(date.getTime())) {
			return '';
		}
		return date.toISOString();
	}

	/**
	 * Generate attachment list markdown
	 */
	generateAttachmentList(attachmentLinks: Map<string, string>): string[] {
		const lines: string[] = [];

		if (attachmentLinks.size === 0) {
			return lines;
		}

		lines.push('### Attachments');
		lines.push('');

		attachmentLinks.forEach((linkName, originalName) => {
			// Skip cid: entries (duplicates)
			if (originalName.startsWith('cid:')) {
				return;
			}

			const ext = linkName.split('.').pop()?.toLowerCase() || '';
			const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);

			if (isImage) {
				lines.push(`- ![[${linkName}]]`);
			} else {
				lines.push(`- [[${linkName}]]`);
			}
		});

		lines.push('');

		return lines;
	}

	/**
	 * Generate Markdown content from parsed email
	 */
	generateMarkdown(
		email: ParsedEmail,
		attachmentLinks: Map<string, string>,
		movedEmlName: string | null
	): string {
		const lines: string[] = [];

		// Frontmatter
		if (this.settings.useFrontmatter) {
			lines.push('---');
			if (email.from.length > 0) {
				lines.push(`from: "${this.escapeYaml(formatEmailAddresses(email.from))}"`);
			}
			if (email.to.length > 0) {
				lines.push(`to: "${this.escapeYaml(formatEmailAddresses(email.to))}"`);
			}
			if (email.cc.length > 0) {
				lines.push(`cc: "${this.escapeYaml(formatEmailAddresses(email.cc))}"`);
			}
			if (email.bcc.length > 0) {
				lines.push(`bcc: "${this.escapeYaml(formatEmailAddresses(email.bcc))}"`);
			}
			if (email.date) {
				lines.push(`date: ${this.formatDateISO(email.date)}`);
			}
			if (email.subject) {
				lines.push(`subject: "${this.escapeYaml(email.subject)}"`);
			}
			if (email.messageId) {
				lines.push(`message_id: "${this.escapeYaml(email.messageId)}"`);
			}
			lines.push('type: email');
			lines.push('---');
			lines.push('');
		}

		// Title
		lines.push(`# ${email.subject || 'Untitled Email'}`);
		lines.push('');

		// Headers in body
		if (this.settings.showHeadersInBody) {
			if (email.from.length > 0) {
				lines.push(`**From:** ${formatEmailAddresses(email.from)}`);
			}
			if (email.to.length > 0) {
				lines.push(`**To:** ${formatEmailAddresses(email.to)}`);
			}
			if (email.cc.length > 0) {
				lines.push(`**CC:** ${formatEmailAddresses(email.cc)}`);
			}
			if (email.date) {
				lines.push(`**Date:** ${this.formatDate(email.date)}`);
			}

			// Link to moved EML if configured
			if (movedEmlName && this.settings.linkMovedEml) {
				lines.push(`**Original:** [[${movedEmlName}]]`);
			}

			lines.push('');
			lines.push('---');
			lines.push('');
		}

		// Attachments at top if configured
		const showAttachmentsTop = this.settings.attachmentListPosition === 'top' ||
			this.settings.attachmentListPosition === 'both';
		const showAttachmentsBottom = this.settings.attachmentListPosition === 'bottom' ||
			this.settings.attachmentListPosition === 'both';

		if (showAttachmentsTop && attachmentLinks.size > 0) {
			lines.push(...this.generateAttachmentList(attachmentLinks));
			lines.push('---');
			lines.push('');
		}

		// Body
		let body = '';
		if (email.textBody) {
			body = email.textBody;
		} else if (email.htmlBody) {
			body = htmlToMarkdown(email.htmlBody);

			// Replace cid: references with attachment links
			attachmentLinks.forEach((linkName, cidRef) => {
				if (cidRef.startsWith('cid:')) {
					body = body.replace(
						new RegExp(`!\\[([^\\]]*)\\]\\(${this.escapeRegex(cidRef)}\\)`, 'g'),
						`![[${linkName}]]`
					);
				}
			});
		}

		if (body) {
			lines.push(body);
			lines.push('');
		}

		// Attachments at bottom if configured
		if (showAttachmentsBottom && attachmentLinks.size > 0) {
			lines.push('---');
			lines.push('');
			lines.push(...this.generateAttachmentList(attachmentLinks));
		}

		return lines.join('\n');
	}

	/**
	 * Escape YAML special characters
	 */
	escapeYaml(str: string): string {
		return str
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n');
	}

	/**
	 * Escape regex special characters
	 */
	escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
