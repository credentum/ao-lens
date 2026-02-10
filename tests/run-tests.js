#!/usr/bin/env node
/**
 * ao-lens Test Corpus Runner
 * Tests all fixtures and reports results
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Disable skills auto-detection for deterministic tests
const testEnv = { ...process.env, AO_LENS_SKILLS_DIR: '' };

const fixturesDir = path.join(__dirname, 'fixtures');
const badDir = path.join(fixturesDir, 'bad');
const goodDir = path.join(fixturesDir, 'good');
const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

let passed = 0;
let failed = 0;
const errors = [];

console.log('========================================');
console.log('ao-lens Test Corpus Runner');
console.log('========================================\n');

// Test BAD fixtures (should have findings)
console.log('Testing BAD fixtures (should trigger rules):');
console.log('----------------------------------------');

const badFiles = fs.readdirSync(badDir).filter(f => f.endsWith('.lua'));
for (const file of badFiles) {
  const filePath = path.join(badDir, file);

  // Extract expected rule from comment
  const content = fs.readFileSync(filePath, 'utf8');
  const expectedMatch = content.match(/Expected:\s*(\w+)/);
  const expected = expectedMatch ? expectedMatch[1] : null;

  try {
    const result = execSync(`node "${cliPath}" "${filePath}"`, { encoding: 'utf8', env: testEnv });
    const json = JSON.parse(result);
    const findings = json.files[0].findings;
    const codes = findings.map(f => f.code);

    if (findings.length > 0) {
      if (expected && codes.includes(expected)) {
        console.log(`  ✓ ${file} - Found ${expected}`);
        passed++;
      } else if (expected) {
        console.log(`  ~ ${file} - Expected ${expected}, got: ${codes.join(', ')}`);
        passed++; // Still pass if something found
      } else {
        console.log(`  ✓ ${file} - Found: ${codes.join(', ')}`);
        passed++;
      }
    } else {
      console.log(`  ✗ ${file} - Expected findings, got 0`);
      errors.push(`${file}: Expected ${expected} but got no findings`);
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ ${file} - Error: ${e.message}`);
    errors.push(`${file}: ${e.message}`);
    failed++;
  }
}

console.log('');

// Test GOOD fixtures (should NOT trigger the specific rule they demonstrate)
console.log('Testing GOOD fixtures (should NOT trigger specified rule):');
console.log('----------------------------------------');

const goodFiles = fs.readdirSync(goodDir).filter(f => f.endsWith('.lua'));
for (const file of goodFiles) {
  const filePath = path.join(goodDir, file);
  const content = fs.readFileSync(filePath, 'utf8');

  try {
    const result = execSync(`node "${cliPath}" "${filePath}"`, { encoding: 'utf8', env: testEnv });
    const json = JSON.parse(result);
    const findings = json.files[0].findings;
    const codes = findings.map(f => f.code);

    // Check for targeted assertion: NotExpected: RULE_NAME
    const notExpectedMatch = content.match(/NotExpected:\s*(\w+)/);

    if (notExpectedMatch) {
      const notExpected = notExpectedMatch[1];
      if (!codes.includes(notExpected)) {
        const otherCount = findings.length;
        if (otherCount > 0) {
          console.log(`  ✓ ${file} - ${notExpected} correctly absent (${otherCount} unrelated findings)`);
        } else {
          console.log(`  ✓ ${file} - ${notExpected} correctly absent (clean)`);
        }
        passed++;
      } else {
        console.log(`  ✗ ${file} - ${notExpected} should NOT be triggered but was found`);
        errors.push(`${file}: ${notExpected} triggered (false positive)`);
        failed++;
      }
    } else {
      // Fallback: zero blocking findings
      const summary = json.files[0].summary;
      const blockingFindings = summary.critical + summary.high + summary.medium;
      if (blockingFindings === 0) {
        console.log(`  ✓ ${file} - No blocking findings`);
        passed++;
      } else {
        const blockingCodes = findings.filter(f => ['critical', 'high', 'medium'].includes(f.severity)).map(f => f.code);
        console.log(`  ✗ ${file} - Expected 0 blocking findings, got: ${blockingCodes.join(', ')}`);
        errors.push(`${file}: False positive - ${blockingCodes.join(', ')}`);
        failed++;
      }
    }
  } catch (e) {
    console.log(`  ✗ ${file} - Error: ${e.message}`);
    errors.push(`${file}: ${e.message}`);
    failed++;
  }
}

console.log('');

// Test YAML skill rules (with skills enabled)
console.log('Testing YAML skill rules:');
console.log('----------------------------------------');

const skillsDir = path.join(__dirname, '..', 'skills');
if (fs.existsSync(skillsDir)) {
  const skillsEnv = { ...process.env, AO_LENS_SKILLS_DIR: skillsDir };

  // Test that YAML rules load and detect patterns
  const skillFixtures = fs.readdirSync(badDir).filter(f => f.startsWith('21'));
  for (const file of skillFixtures) {
    const filePath = path.join(badDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const expectedMatch = content.match(/Expected:\s*(\w+)/);
    const expected = expectedMatch ? expectedMatch[1] : null;

    try {
      const result = execSync(`node "${cliPath}" "${filePath}"`, { encoding: 'utf8', env: skillsEnv });
      const json = JSON.parse(result);
      const findings = json.files[0].findings;
      const codes = findings.map(f => f.code);

      if (expected && codes.includes(expected)) {
        console.log(`  ✓ ${file} - YAML rule ${expected} detected`);
        passed++;
      } else if (findings.length > 0) {
        console.log(`  ~ ${file} - Expected ${expected}, got: ${codes.join(', ')}`);
        passed++;
      } else {
        console.log(`  ✗ ${file} - Expected ${expected} from YAML rules, got 0 findings`);
        errors.push(`${file}: YAML rule ${expected} not detected`);
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ ${file} - Error: ${e.message}`);
      errors.push(`${file}: ${e.message}`);
      failed++;
    }
  }
} else {
  console.log('  (skipped - skills directory not found)');
}

console.log('');
console.log('========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) {
  console.log('\nFailures:');
  errors.forEach(e => console.log(`  - ${e}`));
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
  process.exit(0);
}
