import { createHash } from "crypto";
import {
	Plugin,
	Notice,
	Modal,
	App,
	arrayBufferToBase64,
	base64ToArrayBuffer,
	requestUrl,
} from "obsidian";
import express from "express";
import http from "http";
import dns from "dns";
import os from "os";
import cors from "cors";
import { promisify } from "util";

class SignalDataModal extends Modal {
	onSubmit: (signalData: string) => void;

	constructor(app: App, onSubmit: (signalData: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Enter Signal Data" });

		const inputEl = contentEl.createEl("textarea");
		inputEl.setAttr("rows", "10");
		inputEl.setAttr("cols", "50");
		inputEl.placeholder = "Enter the signal data here...";

		const submitBtn = contentEl.createEl("button", { text: "Connect" });
		submitBtn.onclick = () => {
			this.onSubmit(inputEl.value);
			this.close();
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// TODO: Create change selection system in the case where a file sent by the server doesn't match the old hash and the client's file hash doesn't match the old hash

export default class LocalSyncPlugin extends Plugin {
	server: http.Server<
		typeof http.IncomingMessage,
		typeof http.ServerResponse
	> | null;

	async onload() {
		this.addCommand({
			id: "start-connection",
			name: "Start P2P Connection",
			callback: () => {
				new Notice("Starting sync session.");
				this.setupPeerConnection();
			},
		});

		this.addCommand({
			id: "connect-peer",
			name: "Connect to Peer",
			callback: () => {
				new SignalDataModal(this.app, (signalData) => {
					this.connectToPeer(JSON.parse(signalData));
				}).open();
			},
		});

		this.addCommand({
			id: "close-server",
			name: "Close P2P server",
			callback: () => {
				this.server?.close();
				new Notice("Closed P2P connection server");
			},
		});
	}

	async onunload() {
		if (this.server) {
			this.server.close();
		}
	}

	async setupPeerConnection() {
		const server = express();

		server.use(express.json());
		server.use(cors());

		server.get("/hashes", async (req, res) => {
			const hashes = await this.getVaultHashes();
			const files = [];
			for (const x of hashes) {
				const file = this.app.vault.getFileByPath(x.path)!;
				files.push({
					path: x.path,
					hash: x.hash,
					data: arrayBufferToBase64(
						await this.app.vault.readBinary(file)
					),
				});
			}

			res.json(files);
		});

		server.post("/changes", (req, res) => {
			const files: { path: string; data: string }[] = req.body;
			files
				.map(({ path, data }) => ({
					path,
					data: base64ToArrayBuffer(data),
				}))
				.forEach(({ path, data }) => {
					const file = this.app.vault.getFileByPath(path);
					if (file) {
						this.app.vault.modifyBinary(file, data, {
							mtime: new Date().getUTCSeconds(),
						});
					} else {
						this.app.vault.createBinary(path, data);
					}
				});

			this.saveData({ hashes: this.getVaultHashes() }).then(res.end);
		});

		const addr = await promisify(dns.lookup)(os.hostname(), { family: 4 });
		new Notice("Your sync code is: " + addr.address.split(".").last(), 30);

		this.server = server.listen(56780);

		setTimeout(() => {
			this.server?.close();
			new Notice("Closed P2P connection server - Reason: 30s Timeout", 6);
		}, 30000);
	}

	async getVaultHashes(): Promise<{ path: string; hash: string }[]> {
		const hashes: { path: string; hash: string }[] = [];

		for (const file of this.app.vault.getFiles()) {
			const data = await this.app.vault.readBinary(file);
			hashes.push({
				path: file.path,
				hash: createHash("sha1")
					.update(Buffer.from(data))
					.digest("base64"),
			});
		}

		return hashes;
	}

	async getPreviousSyncHashes(): Promise<{ path: string; hash: string }[]> {
		const data = await this.loadData();

		if (data && data.hashes) return data.hashes;
		else {
			this.saveData({ hashes: await this.getVaultHashes() }).catch(
				console.error
			);
			return [];
		}
	}

	async connectToPeer(code: string) {
		const addr = await promisify(dns.lookup)(os.hostname(), { family: 4 });
		const res = await requestUrl({
			url: `http://${addr.address
				.split(".")
				.slice(0, -1)
				.join(".")}.${code}:56780/hashes`,
			method: "GET",
		});
		const newHashes: { path: string; hash: string; data: string }[] =
			await res.json();
		const hashes = (await this.getVaultHashes()).map(({ path, hash }) => ({
			path,
			hash,
			done: false,
		}));
		const lastSyncHashes = await this.getPreviousSyncHashes();
		newHashes.forEach(({ path, hash, data }) => {
			const file = hashes.find((x) => x.path == path);
			if (
				file &&
				file.hash !== hash &&
				lastSyncHashes.find((x) => x.path == path)?.hash !== hash &&
				this.app.vault.getFileByPath(path)
			) {
				this.app.vault.modifyBinary(
					this.app.vault.getFileByPath(path)!,
					base64ToArrayBuffer(data)
				);
				file.done = true;
			} else {
				this.app.vault.createBinary(path, base64ToArrayBuffer(data));
			}
		});

		const newChanges = hashes
			.filter(({ done }) => !done)
			.map(({ path }) => path);

		const data: { path: string; data: string }[] = [];
		for (const path of newChanges) {
			data.push({
				path,
				data: arrayBufferToBase64(
					await this.app.vault.readBinary(
						this.app.vault.getFileByPath(path)!
					)
				),
			});
		}

		await requestUrl({
			url: `http://${addr.address
				.split(".")
				.slice(0, -1)
				.join(".")}.${code}:56780/changes`,
			method: "POST",
			body: JSON.stringify(data),
			headers: { "Content-Type": "application/json" },
		});

		this.saveData({ hashes: await this.getVaultHashes() });
	}
}
