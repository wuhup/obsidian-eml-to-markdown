/**
 * Lightweight EML parser for Obsidian
 * Parses .eml files without external dependencies
 */

export interface EmailAddress {
	name: string;
	address: string;
}

export interface Attachment {
	filename: string;
	contentType: string;
	content: Buffer;
	contentId?: string;
}

export interface ParsedEmail {
	from: EmailAddress[];
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	subject: string;
	date: Date | null;
	messageId: string;
	textBody: string;
	htmlBody: string;
	attachments: Attachment[];
}

/**
 * Parse an email address string like "John Doe <john@example.com>" or just "john@example.com"
 */
function parseEmailAddress(str: string): EmailAddress {
	str = str.trim();
	const match = str.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
	if (match) {
		return {
			name: match[1].trim().replace(/^"|"$/g, ''),
			address: match[2].trim()
		};
	}
	// Just an email address
	return {
		name: '',
		address: str
	};
}

/**
 * Parse a list of email addresses (comma-separated)
 */
function parseEmailAddresses(str: string): EmailAddress[] {
	if (!str) return [];

	const addresses: EmailAddress[] = [];
	let current = '';
	let inQuotes = false;
	let inAngleBrackets = false;

	for (let i = 0; i < str.length; i++) {
		const char = str[i];

		if (char === '"' && str[i - 1] !== '\\') {
			inQuotes = !inQuotes;
		} else if (char === '<' && !inQuotes) {
			inAngleBrackets = true;
		} else if (char === '>' && !inQuotes) {
			inAngleBrackets = false;
		} else if (char === ',' && !inQuotes && !inAngleBrackets) {
			if (current.trim()) {
				addresses.push(parseEmailAddress(current));
			}
			current = '';
			continue;
		}

		current += char;
	}

	if (current.trim()) {
		addresses.push(parseEmailAddress(current));
	}

	return addresses;
}

/**
 * Decode a MIME encoded word (=?charset?encoding?text?=)
 */
function decodeMimeWord(str: string): string {
	return str.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (match, charset, encoding, text) => {
		try {
			if (encoding.toUpperCase() === 'B') {
				// Base64
				return Buffer.from(text, 'base64').toString('utf-8');
			} else if (encoding.toUpperCase() === 'Q') {
				// Q-encoding: underscores are spaces, =XX are hex bytes
				// Need to decode as UTF-8 bytes, not individual chars
				const withSpaces = text.replace(/_/g, ' ');
				const bytes: number[] = [];
				let i = 0;
				while (i < withSpaces.length) {
					if (withSpaces[i] === '=' && i + 2 < withSpaces.length) {
						const hex = withSpaces.substring(i + 1, i + 3);
						if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
							bytes.push(parseInt(hex, 16));
							i += 3;
							continue;
						}
					}
					bytes.push(withSpaces.charCodeAt(i));
					i++;
				}
				return Buffer.from(bytes).toString('utf-8');
			}
		} catch (e) {
			// Return original on error
		}
		return match;
	});
}

/**
 * Decode quoted-printable to raw bytes (for binary attachments)
 */
function decodeQuotedPrintableToBuffer(str: string): Buffer {
	// First remove soft line breaks
	const withoutSoftBreaks = str.replace(/=\r?\n/g, '');

	// Convert quoted-printable to byte array
	const bytes: number[] = [];
	let i = 0;
	while (i < withoutSoftBreaks.length) {
		if (withoutSoftBreaks[i] === '=' && i + 2 < withoutSoftBreaks.length) {
			const hex = withoutSoftBreaks.substring(i + 1, i + 3);
			if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
				bytes.push(parseInt(hex, 16));
				i += 3;
				continue;
			}
		}
		bytes.push(withoutSoftBreaks.charCodeAt(i));
		i++;
	}

	return Buffer.from(bytes);
}

/**
 * Decode quoted-printable content to UTF-8 string (for text content)
 */
function decodeQuotedPrintable(str: string): string {
	const buffer = decodeQuotedPrintableToBuffer(str);
	// Decode bytes as UTF-8
	try {
		return buffer.toString('utf-8');
	} catch (e) {
		// Fallback: return as-is if decoding fails
		return str.replace(/=\r?\n/g, '');
	}
}

/**
 * Decode base64 content
 */
function decodeBase64(str: string): string {
	try {
		return Buffer.from(str.replace(/\s/g, ''), 'base64').toString('utf-8');
	} catch (e) {
		return str;
	}
}

/**
 * Parse headers from raw text
 */
function parseHeaders(headerText: string): Map<string, string> {
	const headers = new Map<string, string>();

	// Unfold headers (continuation lines start with whitespace)
	const unfoldedText = headerText.replace(/\r?\n[\t ]+/g, ' ');

	const lines = unfoldedText.split(/\r?\n/);

	for (const line of lines) {
		const colonIndex = line.indexOf(':');
		if (colonIndex > 0) {
			const key = line.substring(0, colonIndex).trim().toLowerCase();
			const value = decodeMimeWord(line.substring(colonIndex + 1).trim());
			headers.set(key, value);
		}
	}

	return headers;
}

/**
 * Extract boundary from content-type header
 */
function extractBoundary(contentType: string): string | null {
	const match = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i);
	return match ? match[1] : null;
}

/**
 * Get content transfer encoding
 */
function getEncoding(headers: Map<string, string>): string {
	return (headers.get('content-transfer-encoding') || '7bit').toLowerCase();
}

/**
 * Get content type
 */
function getContentType(headers: Map<string, string>): string {
	const ct = headers.get('content-type') || 'text/plain';
	return ct.split(';')[0].trim().toLowerCase();
}

/**
 * Get charset from content-type
 */
function getCharset(headers: Map<string, string>): string {
	const ct = headers.get('content-type') || '';
	const match = ct.match(/charset\s*=\s*"?([^";]+)"?/i);
	return match ? match[1].toLowerCase() : 'utf-8';
}

/**
 * Get filename from content-disposition or content-type
 */
function getFilename(headers: Map<string, string>): string | null {
	const disposition = headers.get('content-disposition') || '';
	const contentType = headers.get('content-type') || '';

	// Try content-disposition first
	let match = disposition.match(/filename\*?=\s*(?:utf-8'')?["']?([^"';\r\n]+)["']?/i);
	if (match) {
		return decodeMimeWord(decodeURIComponent(match[1]));
	}

	// Try content-type name parameter
	match = contentType.match(/name\s*=\s*"?([^";]+)"?/i);
	if (match) {
		return decodeMimeWord(match[1]);
	}

	return null;
}

/**
 * Decode content based on transfer encoding
 */
function decodeContent(content: string, encoding: string): string {
	switch (encoding) {
		case 'base64':
			return decodeBase64(content);
		case 'quoted-printable':
			return decodeQuotedPrintable(content);
		default:
			return content;
	}
}

/**
 * Decode binary content to Buffer
 */
function decodeContentToBuffer(content: string, encoding: string): Buffer {
	switch (encoding) {
		case 'base64':
			return Buffer.from(content.replace(/\s/g, ''), 'base64');
		case 'quoted-printable':
			// Use raw buffer decoder for binary data, not UTF-8 text decoder
			return decodeQuotedPrintableToBuffer(content);
		default:
			return Buffer.from(content, 'binary');
	}
}

/**
 * Parse a MIME part
 */
function parseMimePart(
	partText: string,
	result: ParsedEmail,
	isTopLevel: boolean = false
): void {
	// Split headers and body
	const headerEndIndex = partText.search(/\r?\n\r?\n/);
	if (headerEndIndex === -1) {
		return;
	}

	const headerText = partText.substring(0, headerEndIndex);
	const bodyText = partText.substring(headerEndIndex).replace(/^\r?\n\r?\n/, '');

	const headers = parseHeaders(headerText);
	const contentType = getContentType(headers);
	const encoding = getEncoding(headers);

	// Check if multipart
	if (contentType.startsWith('multipart/')) {
		const boundary = extractBoundary(headers.get('content-type') || '');
		if (boundary) {
			const parts = bodyText.split(new RegExp(`--${escapeRegex(boundary)}(?:--)?`));
			// Skip first (preamble) and last (epilogue) parts
			for (let i = 1; i < parts.length - 1; i++) {
				const part = parts[i].trim();
				if (part && part !== '--') {
					parseMimePart(part, result);
				}
			}
		}
		return;
	}

	// Handle text content
	if (contentType === 'text/plain') {
		const decoded = decodeContent(bodyText, encoding);
		if (!result.textBody) {
			result.textBody = decoded;
		}
		return;
	}

	if (contentType === 'text/html') {
		const decoded = decodeContent(bodyText, encoding);
		if (!result.htmlBody) {
			result.htmlBody = decoded;
		}
		return;
	}

	// Handle attachments
	const disposition = headers.get('content-disposition') || '';
	const filename = getFilename(headers);

	// Check if it's an attachment or inline content
	if (filename || disposition.includes('attachment') ||
		(!contentType.startsWith('text/') && !contentType.startsWith('multipart/'))) {

		const attachment: Attachment = {
			filename: filename || `attachment_${result.attachments.length + 1}`,
			contentType: contentType,
			content: decodeContentToBuffer(bodyText, encoding),
			contentId: headers.get('content-id')?.replace(/[<>]/g, '')
		};

		result.attachments.push(attachment);
	}
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert HTML to plain text (basic conversion)
 */
export function htmlToPlainText(html: string): string {
	return html
		// Remove scripts and styles
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		// Convert line breaks
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<\/tr>/gi, '\n')
		.replace(/<\/li>/gi, '\n')
		// Remove remaining tags
		.replace(/<[^>]+>/g, '')
		// Decode HTML entities
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)))
		.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Clean up whitespace
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Check if a URL has a safe protocol (http, https, mailto, or cid for inline images)
 */
function isSafeUrl(url: string): boolean {
	const trimmed = url.trim().toLowerCase();
	return trimmed.startsWith('http://') ||
		trimmed.startsWith('https://') ||
		trimmed.startsWith('mailto:') ||
		trimmed.startsWith('cid:');
}

/**
 * Sanitize a URL, returning empty string if unsafe
 */
function sanitizeUrl(url: string): string {
	return isSafeUrl(url) ? url : '';
}

/**
 * Convert HTML to Markdown (basic conversion)
 */
export function htmlToMarkdown(html: string): string {
	return html
		// Remove scripts and styles
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		// Headers
		.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
		.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
		.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
		.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
		.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
		.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')
		// Bold and italic
		.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
		.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
		.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
		.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
		// Links - sanitize URLs to prevent javascript:, file://, etc.
		.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (match, url, text) => {
			const safeUrl = sanitizeUrl(url);
			return safeUrl ? `[${text}](${safeUrl})` : text;
		})
		// Images - sanitize URLs
		.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, (match, url, alt) => {
			const safeUrl = sanitizeUrl(url);
			return safeUrl ? `![${alt}](${safeUrl})` : alt;
		})
		.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, (match, url) => {
			const safeUrl = sanitizeUrl(url);
			return safeUrl ? `![](${safeUrl})` : '';
		})
		// Lists
		.replace(/<ul[^>]*>/gi, '\n')
		.replace(/<\/ul>/gi, '\n')
		.replace(/<ol[^>]*>/gi, '\n')
		.replace(/<\/ol>/gi, '\n')
		.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
		// Line breaks and paragraphs
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<p[^>]*>/gi, '')
		.replace(/<\/div>/gi, '\n')
		.replace(/<div[^>]*>/gi, '')
		// Blockquotes
		.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (match, content) => {
			return content.split('\n').map((line: string) => '> ' + line).join('\n') + '\n\n';
		})
		// Code
		.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
		.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```\n\n')
		// Horizontal rule
		.replace(/<hr[^>]*\/?>/gi, '\n---\n\n')
		// Tables (basic)
		.replace(/<\/tr>/gi, '|\n')
		.replace(/<\/th>/gi, ' | ')
		.replace(/<\/td>/gi, ' | ')
		.replace(/<tr[^>]*>/gi, '|')
		.replace(/<th[^>]*>/gi, '')
		.replace(/<td[^>]*>/gi, '')
		.replace(/<\/?table[^>]*>/gi, '\n')
		.replace(/<\/?thead[^>]*>/gi, '')
		.replace(/<\/?tbody[^>]*>/gi, '')
		// Remove remaining tags
		.replace(/<[^>]+>/g, '')
		// Decode HTML entities
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)))
		.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Clean up whitespace
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Parse an EML file content
 */
export function parseEml(content: string): ParsedEmail {
	const result: ParsedEmail = {
		from: [],
		to: [],
		cc: [],
		bcc: [],
		subject: '',
		date: null,
		messageId: '',
		textBody: '',
		htmlBody: '',
		attachments: []
	};

	// Split headers and body at first blank line
	const headerEndIndex = content.search(/\r?\n\r?\n/);
	if (headerEndIndex === -1) {
		return result;
	}

	const headerText = content.substring(0, headerEndIndex);
	const bodyText = content.substring(headerEndIndex).replace(/^\r?\n\r?\n/, '');

	// Parse top-level headers
	const headers = parseHeaders(headerText);

	result.from = parseEmailAddresses(headers.get('from') || '');
	result.to = parseEmailAddresses(headers.get('to') || '');
	result.cc = parseEmailAddresses(headers.get('cc') || '');
	result.bcc = parseEmailAddresses(headers.get('bcc') || '');
	result.subject = headers.get('subject') || '';
	result.messageId = (headers.get('message-id') || '').replace(/[<>]/g, '');

	// Parse date
	const dateStr = headers.get('date');
	if (dateStr) {
		try {
			result.date = new Date(dateStr);
		} catch (e) {
			result.date = null;
		}
	}

	// Parse body
	const contentType = getContentType(headers);
	const encoding = getEncoding(headers);

	if (contentType.startsWith('multipart/')) {
		const boundary = extractBoundary(headers.get('content-type') || '');
		if (boundary) {
			const parts = bodyText.split(new RegExp(`--${escapeRegex(boundary)}(?:--)?`));
			for (let i = 1; i < parts.length; i++) {
				const part = parts[i].trim();
				if (part && part !== '--') {
					parseMimePart(part, result);
				}
			}
		}
	} else if (contentType === 'text/plain') {
		result.textBody = decodeContent(bodyText, encoding);
	} else if (contentType === 'text/html') {
		result.htmlBody = decodeContent(bodyText, encoding);
	}

	return result;
}

/**
 * Format email address for display
 */
export function formatEmailAddress(addr: EmailAddress): string {
	if (addr.name) {
		return `${addr.name} <${addr.address}>`;
	}
	return addr.address;
}

/**
 * Format email addresses list for display
 */
export function formatEmailAddresses(addrs: EmailAddress[]): string {
	return addrs.map(formatEmailAddress).join(', ');
}
