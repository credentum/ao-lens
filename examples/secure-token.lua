-- A simple AO token process — the secure version.
-- Every vulnerability from vulnerable-token.lua is fixed.

local json = require("json")

-- Replay-safe initialization with 'or' guard
State = State or {
  Name = "MyToken",
  Ticker = "MTK",
  Balances = {},
  TotalSupply = 0,
  Owner = ao.env.Process.Owner,
  Frozen = false
}

Handlers.add("Info", { Action = "Info" }, function(msg)
  ao.send({
    Target = msg.From,
    Data = json.encode({
      Name = State.Name,
      Ticker = State.Ticker,
      TotalSupply = State.TotalSupply
    })
  })
end)

Handlers.add("Balance", { Action = "Balance" }, function(msg)
  local target = msg.Tags.Target or msg.From
  local balance = State.Balances[target] or 0
  ao.send({ Target = msg.From, Data = tostring(balance) })
end)

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
  ao.send({ Target = msg.From, Action = "Mint-Confirmation", Data = tostring(qty) })
end)

Handlers.add("Transfer", { Action = "Transfer" }, function(msg)
  assert(not State.Frozen, "Process is frozen")

  local qty = tonumber(msg.Tags.Quantity)
  assert(qty and qty > 0, "Invalid quantity")

  local recipient = msg.Tags.Recipient
  assert(recipient ~= nil, "Recipient required")

  local sender = msg.From
  assert(State.Balances[sender] and State.Balances[sender] >= qty, "Insufficient balance")

  State.Balances[sender] = State.Balances[sender] - qty
  State.Balances[recipient] = (State.Balances[recipient] or 0) + qty
  State.LastUpdated = msg.Timestamp

  ao.send({ Target = sender, Action = "Debit-Notice", Data = tostring(qty) })
  ao.send({ Target = recipient, Action = "Credit-Notice", Data = tostring(qty) })
end)

Handlers.add("UpdateConfig", function(msg)
  if not msg.Tags then return false end
  if msg.Tags.Action ~= "UpdateConfig" then return false end
  if State.Frozen then return false end
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From == State.Owner, "Unauthorized")

  local ok, data = pcall(json.decode, msg.Data)
  if not ok then
    ao.send({ Target = msg.From, Action = "Error", Data = "Invalid JSON" })
    return
  end

  if type(data.Name) == "string" then State.Name = data.Name end
  if type(data.Ticker) == "string" then State.Ticker = data.Ticker end
  State.LastUpdated = msg.Timestamp

  ao.send({ Target = msg.From, Action = "Config-Updated", Data = "OK" })
end)

Handlers.add("Freeze", function(msg)
  if not msg.Tags then return false end
  if msg.Tags.Action ~= "Freeze" then return false end
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  State.Frozen = true
  ao.send({ Target = msg.From, Action = "Freeze-Confirmation", Data = "Process frozen" })
end)
