require('dotenv').config();
const {REST,Routes}=require('discord.js');
const commands=require('./bot-commands.json');
if(!process.env.DISCORD_BOT_TOKEN||!process.env.DISCORD_CLIENT_ID)throw new Error('Set DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID');
const rest=new REST({version:'10'}).setToken(process.env.DISCORD_BOT_TOKEN);
(async()=>{const route=process.env.DISCORD_GUILD_ID?Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID,process.env.DISCORD_GUILD_ID):Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);await rest.put(route,{body:commands});console.log('Slash commands registered');})();
