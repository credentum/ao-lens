# Your AO Handler Auth Is Probably Broken

In Lua, `nil == nil` evaluates to `true`. If your `State.Owner` is never initialized and someone sends a message to your process, `msg.From == State.Owner` passes. Both sides are nil. This is the most common vulnerability in AO processes, and it's in production code right now.

## The Code That Looks Correct

Here is a token process you might write after reading the AO docs. It has a name, balances, a mint function gated by an owner check. Standard stuff.

```lua
State = {
  Name = "MyToken",
  Ticker = "MTK",
  Balances = {},
  TotalSupply = 0
}

State.Owner = State.Owner or msg.From

Handlers.add("Mint", { Action = "Mint" }, function(msg)
  if msg.From == State.Owner then
    local qty = tonumber(msg.Tags.Quantity)
    local recipient = msg.Tags.Recipient
    State.Balances[recipient] = (State.Balances[recipient] or 0) + qty
    State.TotalSupply = State.TotalSupply + qty
    ao.send({ Target = recipient, Action = "Credit-Notice", Data = tostring(qty) })
  end
end)

Handlers.add("UpdateConfig", { Action = "UpdateConfig" }, function(msg)
  if msg.From == State.Owner then
    local data = json.decode(msg.Data)
    State.Name = data.Name or State.Name
  end
end)
```

Looks reasonable. Owner check on every privileged handler. What could go wrong?

## Run ao-lens Against It

```
$ npx ao-lens audit vulnerable-token.lua

RESULT: FAIL

Critical: 3  High: 8  Medium: 5  Low: 11

  [CRITICAL] OWNER_NEVER_INITIALIZED (line 1)
    State.Owner is referenced but never properly initialized

  [CRITICAL] UNSAFE_OWNER_OR_PATTERN (line 14)
    Owner set with 'or' pattern without assert - could remain nil

  [CRITICAL] FIRST_CALLER_WINS_OWNER (line 14)
    First-caller-wins owner pattern: any caller can claim ownership

  [HIGH] NO_FROZEN_CHECK (line 33)
    Handler "Mint" does not check Frozen state

  [HIGH] JSON_DECODE_NO_PCALL (line 58)
    json.decode() without pcall crashes on malformed JSON
```

Three criticals. Here's how they break you.

## The Three Ways This Breaks

**OWNER_NEVER_INITIALIZED.** The `State` table is created without an `Owner` field. Every handler that checks `msg.From == State.Owner` is comparing against nil. Any message from any sender passes the check, because `nil == nil` is `true` in Lua. Your mint function is open to the world.

**FIRST_CALLER_WINS_OWNER.** The line `State.Owner = State.Owner or msg.From` at the top level means whoever sends the first message to the process becomes the owner. If an attacker sends a message before the legitimate deployer does, they own the process. Nothing validates that `msg.From` is the process creator.

**STATE_OVERWRITE_ON_REPLAY.** AO reconstructs process state by replaying every message from the beginning. The line `State = { ... }` without an `or` guard means every replay wipes all accumulated state. Balances, supply, everything. Back to the initial empty table. Then the first message in the replay sets the owner again, and the entire state rebuilds from scratch with potentially different results if message ordering changes.

These three issues interact. On replay, state gets wiped, owner resets to nil, and the first message through the door claims ownership.

## The Fix

```lua
-- Replay-safe: 'or' guard preserves state across replays
State = State or {
  Name = "MyToken",
  Ticker = "MTK",
  Balances = {},
  TotalSupply = 0,
  Owner = ao.env.Process.Owner,  -- From spawn params, not msg.From
  Frozen = false
}

Handlers.add("Mint", function(msg)
  if not msg.Tags then return false end
  if msg.Tags.Action ~= "Mint" then return false end
  if State.Frozen then return false end
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From == State.Owner, "Unauthorized")
  assert(not State.Frozen, "Process is frozen")

  local qty = tonumber(msg.Tags.Quantity)
  assert(qty and qty > 0, "Invalid quantity")

  local recipient = msg.Tags.Recipient
  assert(recipient ~= nil, "Recipient required")

  State.Balances[recipient] = (State.Balances[recipient] or 0) + qty
  State.TotalSupply = State.TotalSupply + qty
  State.LastUpdated = msg.Timestamp
  ao.send({ Target = recipient, Action = "Credit-Notice", Data = tostring(qty) })
end)
```

Three changes matter:

1. **`State = State or { ... }`**. The `or` guard means replays don't wipe existing state.
2. **`Owner = ao.env.Process.Owner`**. The owner comes from the spawn transaction, not from whoever sends the first message.
3. **Belt-and-suspenders auth.** The matcher rejects unauthorized messages early (before the handler runs), and the handler body asserts again as a safety net. The `Frozen` check gives you an emergency stop.

## Try It

```bash
npx ao-lens audit your-process.lua --pretty
```

It checks for 20+ vulnerability patterns specific to AO. Nil owner traps, replay safety, unguarded JSON decode, missing frozen checks, non-determinism from `os.time()` and `math.random()`.

ao-lens also runs as an MCP server, so Claude Code can analyze your handlers as you write them:

```bash
npx ao-lens-mcp
```

And as a GitHub Action for CI. Catch these before they hit the network:

```yaml
- uses: credentum/ao-lens@v0.1
  with:
    path: src/process.lua
```

The nil-equals-nil trap isn't theoretical. It's the default state of every AO process that skips owner initialization. Check yours.
