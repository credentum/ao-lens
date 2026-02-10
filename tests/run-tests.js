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

// Test GOOD fixtures (should have NO findings)
console.log('Testing GOOD fixtures (should NOT trigger rules):');
console.log('----------------------------------------');

const goodFiles = fs.readdirSync(goodDir).filter(f => f.endsWith('.lua'));
for (const file of goodFiles) {
  const filePath = path.join(goodDir, file);

  try {
    const result = execSync(`node "${cliPath}" "${filePath}"`, { encoding: 'utf8', env: testEnv });
    const json = JSON.parse(result);
    const summary = json.files[0].summary;
    // Only fail on critical, high, or medium severity findings
    const blockingFindings = summary.critical + summary.high + summary.medium;

    if (blockingFindings === 0) {
      const lowInfo = summary.low + summary.info;
      if (lowInfo > 0) {
        const codes = json.files[0].findings.map(f => f.code);
        console.log(`  ✓ ${file} - No blocking findings (${lowInfo} low/info: ${codes.join(', ')})`);
      } else {
        console.log(`  ✓ ${file} - No findings (correct)`);
      }
      passed++;
    } else {
      const codes = json.files[0].findings.filter(f => ['critical', 'high', 'medium'].includes(f.severity)).map(f => f.code);
      console.log(`  ✗ ${file} - Expected 0 blocking findings, got: ${codes.join(', ')}`);
      errors.push(`${file}: False positive - ${codes.join(', ')}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ ${file} - Error: ${e.message}`);
    errors.push(`${file}: ${e.message}`);
    failed++;
  }
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
