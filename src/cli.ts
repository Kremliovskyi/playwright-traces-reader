#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

const [, , command, ...args] = process.argv;

async function initSkills(targetDir: string): Promise<void> {
  const skillDir = path.join(targetDir, '.github', 'skills', 'analyze-playwright-traces');
  await fs.promises.mkdir(skillDir, { recursive: true });

  // Copy the template SKILL.md from this package
  const templatePath = path.resolve(__dirname, '..', 'templates', 'skills', 'analyze-playwright-traces', 'SKILL.md');
  const destPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(templatePath)) {
    console.error(`Template not found at ${templatePath}`);
    process.exit(1);
  }

  await fs.promises.copyFile(templatePath, destPath);
  console.log(`✔ Skill scaffolded at ${destPath}`);
}

async function main(): Promise<void> {
  if (command === 'init-skills') {
    const targetDir = args[0] ?? process.cwd();
    await initSkills(targetDir);
    return;
  }

  console.log(`
playwright-traces-reader — CLI for parsing Playwright trace files

Usage:
  npx playwright-traces-reader init-skills [targetDir]
    Scaffolds the GitHub Copilot skill template into <targetDir>/.github/skills/analyze-playwright-traces/SKILL.md
    Defaults targetDir to the current working directory.
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
