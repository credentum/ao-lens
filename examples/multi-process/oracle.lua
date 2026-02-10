-- Price oracle process — receives updates from AMM, serves price queries

local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false,
  AllowedSources = {},  -- process IDs allowed to submit prices
  Prices = {},          -- { pair: { price, timestamp, volume } }
  HistoryLimit = 100
}

-- Register an AMM as a price source
Handlers.add("RegisterSource", { Action = "RegisterSource" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  assert(not State.Frozen, "Frozen")
  local source = msg.Tags.Source
  assert(source, "Source required")
  State.AllowedSources[source] = true
  ao.send({ Target = msg.From, Action = "Source-Registered", Data = source })
end)

-- Receive price update from AMM
Handlers.add("Price-Update", { Action = "Price-Update" }, function(msg)
  assert(State.AllowedSources[msg.From], "Unregistered source")

  local ok, data = pcall(json.decode, msg.Data)
  if not ok then return end

  local pair = msg.From  -- use source process ID as pair key
  if not State.Prices[pair] then
    State.Prices[pair] = { history = {} }
  end

  State.Prices[pair].current = {
    price = data.Price,
    volume = data.Volume,
    timestamp = msg.Timestamp,
    tradeCount = data.TradeCount
  }

  -- Keep price history
  table.insert(State.Prices[pair].history, {
    price = data.Price,
    timestamp = msg.Timestamp
  })

  -- Trim history
  if #State.Prices[pair].history > State.HistoryLimit then
    table.remove(State.Prices[pair].history, 1)
  end
end)

-- Query current price
Handlers.add("GetPrice", { Action = "GetPrice" }, function(msg)
  local pair = msg.Tags.Pair
  local priceData = State.Prices[pair]
  if priceData and priceData.current then
    ao.send({ Target = msg.From, Action = "Price-Response",
      Data = json.encode(priceData.current) })
  else
    ao.send({ Target = msg.From, Action = "Price-Response",
      Data = json.encode({ error = "No price data" }) })
  end
end)

-- Query price history
Handlers.add("GetHistory", { Action = "GetHistory" }, function(msg)
  local pair = msg.Tags.Pair
  local priceData = State.Prices[pair]
  if priceData then
    ao.send({ Target = msg.From, Action = "History-Response",
      Data = json.encode(priceData.history) })
  else
    ao.send({ Target = msg.From, Action = "History-Response",
      Data = json.encode({}) })
  end
end)
