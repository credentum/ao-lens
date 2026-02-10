-- A simple AO token process
-- Looks correct at first glance. It isn't.

local json = require("json")

State = {
  Name = "MyToken",
  Ticker = "MTK",
  Balances = {},
  TotalSupply = 0
}

-- Set the process owner
State.Owner = State.Owner or msg.From

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

Handlers.add("Mint", { Action = "Mint" }, function(msg)
  if msg.From == State.Owner then
    local qty = tonumber(msg.Tags.Quantity)
    local recipient = msg.Tags.Recipient
    State.Balances[recipient] = (State.Balances[recipient] or 0) + qty
    State.TotalSupply = State.TotalSupply + qty
    ao.send({ Target = recipient, Action = "Credit-Notice", Data = tostring(qty) })
  end
end)

Handlers.add("Transfer", { Action = "Transfer" }, function(msg)
  local qty = tonumber(msg.Tags.Quantity)
  local recipient = msg.Tags.Recipient
  local sender = msg.From

  if State.Balances[sender] >= qty then
    State.Balances[sender] = State.Balances[sender] - qty
    State.Balances[recipient] = (State.Balances[recipient] or 0) + qty
    ao.send({ Target = sender, Action = "Debit-Notice", Data = tostring(qty) })
    ao.send({ Target = recipient, Action = "Credit-Notice", Data = tostring(qty) })
  end
end)

Handlers.add("UpdateConfig", { Action = "UpdateConfig" }, function(msg)
  if msg.From == State.Owner then
    local data = json.decode(msg.Data)
    State.Name = data.Name or State.Name
    State.Ticker = data.Ticker or State.Ticker
  end
end)

Handlers.add("SetAdmin", { Action = "SetAdmin" }, function(msg)
  if msg.From == State.Owner then
    State.Admin = msg.Tags.Admin
    ao.send({ Target = msg.From, Data = "Admin updated to " .. msg.Tags.Admin })
  end
end)
