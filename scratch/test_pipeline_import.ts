import client from "../src/module/bot/bot.js";
import { utils, Api } from "teleproto";
import bigInt from "big-integer";
import { createWriteStream, existsSync, statSync } from "node:fs";

console.log("Testing pipelined downloader imports...");
console.log("utils.getFileInfo available:", typeof utils?.getFileInfo);
