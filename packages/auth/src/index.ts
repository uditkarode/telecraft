import { Plugin } from "@telecraft/types";

import { parse } from "nbt-ts";

const pkg = require("../package.json") as { name: string; version: string };

const createError = (...str: string[]) =>
	new Error(`[${pkg.name}@${pkg.version}] ` + str.join(" "));

// Get 4 random numbers
const rand = () => String(Math.ceil(Math.random() * 10000));

const gameModes = ["survival", "creative", "adventure", "spectator"] as const;
type gameModes = typeof gameModes[number];

type Messenger = {
	send: (user: string | number, msg: string) => Promise<void>;
	on: (type: string, listener: (context: any) => void) => void;
};

type Pos = [number, number, number];

type AuthCache = {
	[player: string]: {
		lockRef: NodeJS.Timeout;
		code?: string;
		gameMode: gameModes;
		op?: boolean;
	};
};

const auth: Plugin<
	{ enable: boolean; use: "@telecraft/telegram" | "@telecraft/irc" },
	[Messenger]
> = config => ({
	name: pkg.name,
	version: pkg.version,
	dependencies: [config.use],
	start: async ({ events, store, server, console }, [messenger]) => {
		if (!config.enable) return;
		if (!messenger)
			throw createError(
				"Plugin was enabled, but dependency 'messenger' was not passed",
			);

		const authStore = await store<{
			telegram?: number;
			gameMode?: string;
			op?: boolean;
		}>();

		const authCache = new Map<
			string,
			{
				lockRef?: NodeJS.Timeout;
				code?: string;
				gameMode?: gameModes;
				op?: boolean;
			}
		>();

		const setAuthCache = (
			player: string,
			details: Partial<AuthCache[string]>,
		) => {
			authCache.set(player, { ...authCache.get(player), ...details });
		};

		const lock = (user: string) => {
			server.send(`effect give ${user} minecraft:blindness 1000000`);
			server.send(`effect give ${user} minecraft:slowness 1000000 255`);
			server.send(`gamemode spectator ${user}`);
			server.send(`deop ${user}`);
		};

		const unlock = async (user: string) => {
			const opts = await authStore.get(user);

			const mode = opts?.gameMode || authCache.get(user)?.gameMode;
			const op = opts?.op || authCache.get(user)?.op;

			authCache.delete(user);

			server.send(`effect clear ${user} minecraft:blindness`);
			server.send(`effect clear ${user} minecraft:slowness`);
			server.send(`gamemode ${mode} ${user}`);
			if (op) server.send(`op ${user}`);
		};

		const tpLock = (
			player: string,
			dimension: string,
			pos: Pos,
			gameMode: gameModes,
		) =>
			setAuthCache(player, {
				lockRef: setInterval(() => {
					server.send(
						`execute in ${dimension} run tp ${player} ${pos.join(" ")}`,
					);
				}, 400),
				gameMode,
			});

		events.on("minecraft:join", async (ctx: { user: string }) => {
			const player = ctx.user;
			const storeUser = await authStore.get(player);

			server.send(`data get entity ${player}`);

			lock(player);

			events.once(
				"minecraft:deop",
				(ctx: { user?: string; op?: string; notop?: string }) =>
					setAuthCache(player, { op: Boolean(ctx.op) }),
			);

			const lockUser = (ctx: any) => {
				const data = parse(ctx.data) as any;

				if(data.user === player) {
					events.off("minecraft:data", lockUser);
					const playerGameType: gameModes = gameModes[data.playerGameType.value];
					const pos: Pos = data.Pos as Pos;
					const dimension: string = data.Dimension;

					tpLock(player, dimension, pos, playerGameType);

					if (storeUser?.telegram) {
						server.send(`tellraw ${player} "Send /auth to the bridge bot."`);
						messenger.send(
							storeUser.telegram,
							"Send /auth to authenticate yourself.",
						);
					} else {
						setAuthCache(player, { code: rand() });

						server.send(
							// Todo(mkr): make link copyable
							`tellraw ${player} "Send \`/link ${
								authCache.get(player)!.code
							}\` to the bridge bot."`,
						);
						server.send(
							`title ${player} title "Send /link ${authCache.get(player)!.code}"`,
						);
						server.send(`title ${player} subtitle "to bridge bot"`);
					}
				}
			}

			events.on("minecraft:data", lockUser);
		});

		events.on("minecraft:leave", async (ctx: { user: string }) => {
			const cacheUser = authCache.get(ctx.user);

			if (!cacheUser) return;

			const storeUser = await authStore.get(ctx.user);

			await authStore.set(ctx.user, {
				telegram: storeUser?.telegram,
				gameMode: cacheUser.gameMode,
				op: cacheUser.op,
			});

			cacheUser.lockRef && clearTimeout(cacheUser.lockRef);

			authCache.delete(ctx.user);
		});

		messenger.on("link", async ctx => {
			const fromId = ctx.from.id;
			const chatId = ctx.from.chat;

			if (fromId !== chatId) return messenger.send(chatId, "Send link in PM.");

			if (![...authCache.entries()].length)
				return messenger.send(fromId, "Login to the server first.");

			if (!ctx.value) return messenger.send(fromId, "No code provided.");

			const match = [...authCache.keys()].find(
				player => authCache.get(player)!.code === ctx.value,
			);

			if (!match) return messenger.send(fromId, "Incorrect code.");

			const cacheUser = authCache.get(match);

			// Todo(mkr): Refactor link & auth common tasks into one
			await unlock(match);
			cacheUser?.lockRef && clearTimeout(cacheUser.lockRef);
			await authStore.set(match, { telegram: fromId });

			messenger.send(fromId, "Link successful!");
		});

		messenger.on("unlink", async ctx => {
			const fromId = ctx.from.id;
			const chatId = ctx.from.chat;
			const username = ctx.from.username;

			const existingUser = await authStore.find(fromId);
			if(!existingUser)
				return messenger.send(chatId, "You can't unlink if you never linked!");

			await authStore.remove(existingUser[0]);
			return messenger.send(chatId, `Successfuly unlinked ${username} from ${existingUser[0]}`);
		})

		messenger.on("auth", async ctx => {
			const fromId = ctx.from.id;
			const chatId = ctx.from.chat;
			const result = await authStore.find(fromId);

			if (!result)
				return messenger.send(chatId, "You must link first before using auth.");

			const [mcName, record] = result;

			const cacheUser = authCache.get(mcName);

			if (!cacheUser)
				return messenger.send(chatId, "You are either not logged in or have already authorised yourself.");

			// Todo(mkr): Refactor link & auth common tasks into one
			await unlock(mcName);
			cacheUser?.lockRef && clearTimeout(cacheUser.lockRef);
			await authStore.set(mcName, { telegram: record.telegram });

			return messenger.send(
				chatId,
				"You have successfully authenticated yourself.",
			);
		});

		events.on("core:close", () => {
			// cleanup
			authStore.close();
		});
	},
});

export default auth;
