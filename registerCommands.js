import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const commands = [

  new SlashCommandBuilder()
    .setName('posttoforum-reply')
    .setDescription('Antwort in bestehendem Forum-Thread posten')
    .addStringOption(option =>
      option.setName('thread')
        .setDescription('Thread auswählen')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Nachricht')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('posttoforum-new')
    .setDescription('Neuen Forum-Thread erstellen')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Kategorie')
        .setRequired(true)
        .addChoices(
          { name: 'News & Questions', value: 'News & Questions' },
          { name: 'Le café unité', value: 'Le café unité' },
          { name: 'Politik & Gesellschaft', value: 'Politik & Gesellschaft' },
          { name: 'Out of space', value: 'Out of space' },
          { name: 'Entartete Kunst', value: 'Entartete Kunst' },
          { name: 'Texte & Lyrics', value: 'Texte & Lyrics' },
          { name: 'Gegenwelt', value: 'Gegenwelt' },
          { name: 'My Story', value: 'My Story' },
          { name: 'Eigene Projekte', value: 'Eigene Projekte' },
          { name: 'Mensa', value: 'Mensa' },
          { name: 'Public', value: 'Public' },
          { name: 'Müllhalde', value: 'Müllhalde' }
        )
    )
    .addStringOption(option =>
      option.setName('threadname')
        .setDescription('Titel des neuen Threads')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('tags')
        .setDescription('Mindestens 1 Tag, Komma getrennt')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Inhalt des Threads')
        .setRequired(true)
    )

].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registriere Slash Commands...');

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log('Slash Commands erfolgreich registriert');
  } catch (error) {
    console.error('Fehler beim Registrieren:', error);
  }
})();
