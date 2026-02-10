-- Token process — standard AO token with transfer notifications

local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false,
  Name = "PoolToken",
  Ticker = "PTK",
  Balances = {},
  TotalSupply = 1000000
}

Handlers.add("Transfer", { Action = "Transfer" }, function(msg)
  assert(not State.Frozen, "Frozen")
  local qty = tonumber(msg.Tags.Quantity)
  assert(qty and qty > 0, "Invalid quantity")
  local recipient = msg.Tags.Recipient
  assert(recipient, "Recipient required")
  local sender = msg.From

  assert(State.Balances[sender] and State.Balances[sender] >= qty, "Insufficient balance")

  State.Balances[sender] = State.Balances[sender] - qty
  State.Balances[recipient] = (State.Balances[recipient] or 0) + qty

  -- Notify both parties
  ao.send({ Target = sender, Action = "Debit-Notice",
    Tags = { Quantity = tostring(qty), Recipient = recipient } })
  ao.send({ Target = recipient, Action = "Credit-Notice",
    Tags = { Quantity = tostring(qty), Sender = sender } })
end)

Handlers.add("Mint", { Action = "Mint" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  assert(not State.Frozen, "Frozen")
  local qty = tonumber(msg.Tags.Quantity)
  local recipient = msg.Tags.Recipient or msg.From
  State.Balances[recipient] = (State.Balances[recipient] or 0) + qty
  State.TotalSupply = State.TotalSupply + qty
  ao.send({ Target = recipient, Action = "Credit-Notice",
    Tags = { Quantity = tostring(qty) } })
end)

Handlers.add("Balance", { Action = "Balance" }, function(msg)
  local target = msg.Tags.Target or msg.From
  ao.send({ Target = msg.From, Action = "Balance-Response",
    Data = tostring(State.Balances[target] or 0) })
end)

Handlers.add("Info", { Action = "Info" }, function(msg)
  ao.send({ Target = msg.From, Data = json.encode({
    Name = State.Name, Ticker = State.Ticker, TotalSupply = State.TotalSupply
  }) })
end)
