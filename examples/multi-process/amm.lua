-- AMM process — receives tokens, executes swaps, sends results to oracle

local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false,
  TokenA = nil,
  TokenB = nil,
  OracleProcess = nil,
  ReserveA = 0,
  ReserveB = 0,
  FeeRate = 30,
  TradeCount = 0
}

-- Handle incoming token credits (deposit)
Handlers.add("Credit-Notice", { Action = "Credit-Notice" }, function(msg)
  local qty = tonumber(msg.Tags.Quantity)
  if msg.From == State.TokenA then
    State.ReserveA = State.ReserveA + qty
  elseif msg.From == State.TokenB then
    State.ReserveB = State.ReserveB + qty
  end
end)

-- Execute a swap
Handlers.add("Swap", { Action = "Swap" }, function(msg)
  assert(not State.Frozen, "Frozen")

  local ok, data = pcall(json.decode, msg.Data)
  if not ok then
    ao.send({ Target = msg.From, Action = "Error", Data = "Invalid JSON" })
    return
  end

  local amountIn = tonumber(data.AmountIn)
  local direction = data.Direction

  -- Constant product formula
  local amountOut
  if direction == "AtoB" then
    amountOut = State.ReserveB * amountIn / (State.ReserveA + amountIn)
    State.ReserveA = State.ReserveA + amountIn
    State.ReserveB = State.ReserveB - amountOut
  else
    amountOut = State.ReserveA * amountIn / (State.ReserveB + amountIn)
    State.ReserveB = State.ReserveB + amountIn
    State.ReserveA = State.ReserveA - amountOut
  end

  State.TradeCount = State.TradeCount + 1

  -- Send swap result to trader
  ao.send({ Target = msg.From, Action = "Swap-Result",
    Data = json.encode({ AmountOut = amountOut, Direction = direction }) })

  -- Report price to oracle
  ao.send({ Target = State.OracleProcess, Action = "Price-Update",
    Data = json.encode({
      Price = State.ReserveA / State.ReserveB,
      Volume = amountIn,
      TradeCount = State.TradeCount
    }) })
end)

-- Query pool state
Handlers.add("GetPool", { Action = "GetPool" }, function(msg)
  ao.send({ Target = msg.From, Action = "Pool-Info",
    Data = json.encode({
      ReserveA = State.ReserveA,
      ReserveB = State.ReserveB,
      FeeRate = State.FeeRate,
      TradeCount = State.TradeCount
    }) })
end)

-- Configure pool (owner only)
Handlers.add("Configure", { Action = "Configure" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  local ok, data = pcall(json.decode, msg.Data)
  if not ok then return end
  if data.TokenA then State.TokenA = data.TokenA end
  if data.TokenB then State.TokenB = data.TokenB end
  if data.OracleProcess then State.OracleProcess = data.OracleProcess end
  if data.FeeRate then State.FeeRate = data.FeeRate end
  ao.send({ Target = msg.From, Action = "Configured", Data = "OK" })
end)
