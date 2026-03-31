require('dotenv').config();
if (!process.env.DISCORD_BOT_TOKEN) { console.error('ERROR: DISCORD_BOT_TOKEN missing'); process.exit(1); }
if (!process.env.DISCORD_CHANNEL_ID) { console.error('ERROR: DISCORD_CHANNEL_ID missing'); process.exit(1); }

const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const axios = require('axios');

const SERVER = process.env.FRONTEND_URL || 'http://localhost:3000';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
    console.log('========================================');
    console.log('  Bot: ' + client.user.tag);
    console.log('  Channel: ' + CHANNEL_ID);
    console.log('  Servers: ' + client.guilds.cache.size);
    client.guilds.cache.forEach(g => console.log('    -> ' + g.name));
    console.log('  ONLINE — !ping to test, !reset to clear');
    console.log('========================================');
    setInterval(checkNewApps, 5000);
});

client.on('error', e => console.error('[ERROR]', e.message));
process.on('unhandledRejection', e => console.error('[REJECT]', e));

async function checkNewApps() {
    try {
        const res = await axios.get(SERVER + '/api/application/unsent');
        for (const doc of res.data) {
            const channel = client.channels.cache.get(CHANNEL_ID);
            if (!channel) { console.error('[Bot] Channel not found'); return; }

            const embed = new EmbedBuilder()
                .setColor(0x5d9b3a)
                .setTitle('New Team Application')
                .setDescription('**' + doc.minecraftName + '** wants to join.')
                .addFields(
                    { name: 'Minecraft Username', value: doc.minecraftName, inline: true },
                    { name: 'Age', value: String(doc.age), inline: true },
                    { name: 'Email', value: doc.email, inline: true },
                    { name: 'Play History', value: doc.playHistory },
                    { name: 'Skills', value: doc.skills },
                    { name: 'Past Teams', value: doc.pastTeams },
                    { name: 'Why Join?', value: doc.whyJoin }
                );
            if (doc.portfolio) embed.addFields({ name: 'Portfolio', value: doc.portfolio });
            if (doc.additional) embed.addFields({ name: 'Additional', value: doc.additional });
            embed.setFooter({ text: 'ID: ' + doc.id }).setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('accept_' + doc.id).setLabel('Accept').setStyle(ButtonStyle.Success).setEmoji('\u2705'),
                new ButtonBuilder().setCustomId('deny_' + doc.id).setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('\u274C'),
                new ButtonBuilder().setCustomId('denyreason_' + doc.id).setLabel('Deny with Reason').setStyle(ButtonStyle.Primary).setEmoji('\uD83D\uDCDD')
            );

            await channel.send({ embeds: [embed], components: [row] });
            await axios.post(SERVER + '/api/application/mark-sent', { id: doc.id });
            console.log('[Bot] Sent embed for ' + doc.minecraftName);
        }
    } catch(e) {}
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.content === '!ping') {
        const s = await msg.reply('Pinging...');
        await s.edit('```\n  BOT ONLINE\n  Latency: ' + (s.createdTimestamp - msg.createdTimestamp) + 'ms\n```');
    }

    if (msg.content === '!reset') {
        try {
            await axios.get(SERVER + '/api/reset');
            await msg.reply('\u2705 All applications cleared. You can submit again.');
            console.log('[Bot] Reset by ' + msg.author.tag);
        } catch(e) { await msg.reply('\u274C ' + e.message); }
    }
});

client.on('interactionCreate', async (i) => {
    if (i.isButton()) {
        const id = i.customId;
        try {
            await i.deferReply({ ephemeral: true });
            const url = SERVER + '/api/application/decision';

            if (id.startsWith('accept_')) {
                const appId = id.replace('accept_', '');
                await axios.post(url, { applicationId: appId, status: 'accepted' });
                await i.message.edit({ embeds: [EmbedBuilder.from(i.message.embeds[0]).setColor(0x2ed573).setTitle('ACCEPTED').setTimestamp()], components: [] });
                await i.editReply('\u2705 Accepted. Email sent.');
            }
            else if (id.startsWith('deny_') && !id.startsWith('denyreason_')) {
                const appId = id.replace('deny_', '');
                await axios.post(url, { applicationId: appId, status: 'denied' });
                await i.message.edit({ embeds: [EmbedBuilder.from(i.message.embeds[0]).setColor(0xff4757).setTitle('DENIED').setTimestamp()], components: [] });
                await i.editReply('\u274C Denied. Email sent.');
            }
            else if (id.startsWith('denyreason_')) {
                const appId = id.replace('denyreason_', '');
                const modal = new ModalBuilder().setCustomId('rm_' + appId).setTitle('Deny with Reason');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('r').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(5).setMaxLength(500).setPlaceholder('Why was this denied?')
                ));
                await i.deleteReply();
                await i.showModal(modal);
            }
        } catch(e) { await i.editReply('Error: ' + (e.response?.data?.error || e.message)); }
    }

    if (i.isModalSubmit() && i.customId.startsWith('rm_')) {
        const appId = i.customId.replace('rm_', '');
        const reason = i.fields.getTextInputValue('r');
        try {
            await i.deferReply({ ephemeral: true });
            await axios.post(SERVER + '/api/application/decision', { applicationId: appId, status: 'denied', denyReason: reason });
            const msgs = await i.channel.messages.fetch({ limit: 100 });
            let target = null;
            for (const [, m] of msgs) { if (m.embeds[0]?.footer?.text?.includes(appId)) { target = m; break; } }
            if (target) {
                await target.edit({ embeds: [EmbedBuilder.from(target.embeds[0]).setColor(0xff4757).setTitle('DENIED').addFields({ name: 'Reason', value: reason }).setTimestamp()], components: [] });
            }
            await i.editReply('\u274C Denied with reason. Email sent.');
        } catch(e) { await i.editReply('Error: ' + (e.response?.data?.error || e.message)); }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN).then(() => console.log('[Bot] Connected!')).catch(e => {
    console.error('LOGIN FAILED: ' + e.code + ' — ' + e.message);
    if (e.code === 'DisallowedIntents') console.error('FIX: Developer Portal -> Bot -> ENABLE Message Content Intent');
    if (e.code === 'TokenInvalid') console.error('FIX: Developer Portal -> Bot -> Reset Token -> copy to .env');
    process.exit(1);
});