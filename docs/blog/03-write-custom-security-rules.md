# Write Custom Security Rules for Your AO Process

## The Problem

ao-lens ships with 42 built-in checks. But your project has its own patterns. A DeFi pool needs different checks than a social feed. Custom YAML rules teach ao-lens your project's specific vulnerabilities.

## Your First Rule File

Create `skills/ao/skill_defi_safety.yaml`:

```yaml
skill_id: skill_defi_safety
title: "DeFi Safety Rules for AO"
domain: lua/ao
priority: critical
tech_stack: [lua, ao]

anti_patterns:
  - id: DIVISION_WITHOUT_ZERO_CHECK
    description: "Division by pool reserve without checking for zero"
    severity: critical
    detection:
      type: regex
      pattern: "Reserve[AB]\\s*[/]"
      requires_context: "Reserve[AB]\\s*[>~]"
      lines_to_check: 3
    bad_code: |
      -- Crashes if ReserveB is 0
      local price = State.ReserveA / State.ReserveB
    good_code: |
      assert(State.ReserveB > 0, "Pool has no liquidity")
      local price = State.ReserveA / State.ReserveB
```

## Detection Types

Two detection strategies:

**1. Regex.** Match source code patterns.

```yaml
detection:
  type: regex
  pattern: "FeeRate\\s*=\\s*(?:data|msg|tonumber)"
```

Add `requires_context` to check if a guard exists nearby:

```yaml
detection:
  type: regex
  pattern: "Reserve[AB]\\s*[/]"
  requires_context: "Reserve[AB]\\s*[>~]"
  lines_to_check: 3
```

If the pattern matches but the guard is found within 3 lines, ao-lens suppresses the finding.

**2. Handler Analysis.** Semantic matching on handler names and bodies.

```yaml
detection:
  type: handler_analysis
  handler_name_contains: ["Swap"]
  body_matches: "Reserve[AB]"
  body_not_matches: "[Mm]in[Oo]ut|slippage|minimum"
```

This finds handlers named "Swap" that reference reserves but never check minimum output. That's a slippage vulnerability.

## Running Custom Rules

```bash
# Point to your rules directory
ao-lens audit process.lua --skills-dir ./skills --pretty

# Or set via environment variable
AO_LENS_SKILLS_DIR=./skills ao-lens audit process.lua --pretty

# List loaded rules
ao-lens rules --skills-dir ./skills
```

Output:

```
Loaded 3 detection rules:

By detection type:
  regex: 2
  handler_analysis: 1

By severity:
  critical: 1
  high: 2

Rules:
  [CRITICAL] DIVISION_WITHOUT_ZERO_CHECK
    Skill: skill_defi_safety
    Type: regex
  [HIGH] NO_SLIPPAGE_PROTECTION
    Skill: skill_defi_safety
    Type: handler_analysis
  [HIGH] UNBOUNDED_FEE_RATE
    Skill: skill_defi_safety
    Type: regex
```

## A Complete Rule File

The full `skill_defi_safety.yaml` with all three rules:

```yaml
skill_id: skill_defi_safety
title: "DeFi Safety Rules for AO"
domain: lua/ao
priority: critical
tech_stack: [lua, ao]

anti_patterns:
  - id: DIVISION_WITHOUT_ZERO_CHECK
    description: "Division by pool reserve without checking for zero"
    severity: critical
    detection:
      type: regex
      pattern: "Reserve[AB]\\s*[/]"
      requires_context: "Reserve[AB]\\s*[>~]"
      lines_to_check: 3
    bad_code: |
      -- Crashes if ReserveB is 0
      local price = State.ReserveA / State.ReserveB
    good_code: |
      assert(State.ReserveB > 0, "Pool has no liquidity")
      local price = State.ReserveA / State.ReserveB

  - id: NO_SLIPPAGE_PROTECTION
    description: "Swap handler without minimum output check"
    severity: high
    detection:
      type: handler_analysis
      handler_name_contains: ["Swap"]
      body_matches: "Reserve[AB]"
      body_not_matches: "[Mm]in[Oo]ut|slippage|minimum"
    bad_code: |
      -- No minimum output -- MEV bots can sandwich this trade
      Handlers.add("Swap", { Action = "Swap" }, function(msg)
        local amountOut = calculateSwap(msg.Data)
        sendTokens(msg.From, amountOut)
      end)
    good_code: |
      Handlers.add("Swap", { Action = "Swap" }, function(msg)
        local amountOut = calculateSwap(msg.Data)
        assert(amountOut >= data.MinOut, "Slippage exceeded")
        sendTokens(msg.From, amountOut)
      end)

  - id: UNBOUNDED_FEE_RATE
    description: "Fee rate set from user input without bounds check"
    severity: high
    detection:
      type: regex
      pattern: "FeeRate\\s*=\\s*(?:data|msg|tonumber)"
    bad_code: |
      -- Owner can set fee to 10000 (100%) and drain the pool
      State.FeeRate = tonumber(msg.Tags.FeeRate)
    good_code: |
      local newRate = tonumber(msg.Tags.FeeRate)
      assert(newRate >= 1 and newRate <= 100, "Fee must be 0.01%-1%")
      State.FeeRate = newRate
```

Each rule has five fields: `id` (unique identifier), `description` (what it catches), `severity` (critical, high, medium, or low), `detection` (how to find it), and `bad_code`/`good_code` (examples for context).

## Included Rule Files

ao-lens ships with 7 rule files (20 rules) covering:

| File | Rules | Covers |
|------|-------|--------|
| skill_ao_authorization | 3 | nil==nil bypass, first-caller-wins, missing auth |
| skill_ao_determinism | 4 | os.time, math.random, os.date, io.* |
| skill_ao_json_safety | 2 | json.decode/encode without pcall |
| skill_ao_frozen_state | 2 | missing emergency stop, uninitialized frozen |
| skill_lua_nil_safety | 3 | nil concat crash, 0-is-truthy, nested table access |
| skill_ao_handler_patterns | 3 | hasMatchingTag without body auth, nil send target |
| skill_ao_replay_safe_init | 3 | State={} wipes on replay, globals without or |

## Contributing Rules

PRs welcome. Drop a YAML file in `skills/ao/` and open a pull request.

Links:
- [Example rules](https://github.com/credentum/ao-lens/tree/main/skills)
- [Example DeFi rules](https://github.com/credentum/ao-lens/tree/main/examples/custom-rules)
