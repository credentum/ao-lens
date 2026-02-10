-- A basic AMM liquidity pool on AO
-- Has project-specific patterns that need custom rules

local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false,
  TokenA = nil,  -- Process ID of token A
  TokenB = nil,  -- Process ID of token B
  ReserveA = 0,
  ReserveB = 0,
  LPShares = {},
  TotalShares = 0,
  FeeRate = 30,  -- 0.3% = 30 basis points
  SlippageTolerance = 500,  -- 5% = 500 basis points
  LastPrice = 0
}

-- Initialize pool with token pair
Handlers.add("InitPool", { Action = "InitPool" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  assert(not State.Frozen, "Frozen")

  local ok, data = pcall(json.decode, msg.Data)
  if not ok then
    ao.send({ Target = msg.From, Action = "Error", Data = "Invalid JSON" })
    return
  end

  State.TokenA = data.TokenA
  State.TokenB = data.TokenB
  State.LastUpdated = msg.Timestamp
  ao.send({ Target = msg.From, Action = "Pool-Initialized", Data = "OK" })
end)

-- Add liquidity
Handlers.add("AddLiquidity", { Action = "AddLiquidity" }, function(msg)
  assert(not State.Frozen, "Frozen")

  local amountA = tonumber(msg.Tags.AmountA)
  local amountB = tonumber(msg.Tags.AmountB)

  -- Calculate LP shares using constant product formula
  local shares
  if State.TotalShares == 0 then
    shares = math.sqrt(amountA * amountB)
  else
    shares = math.min(
      amountA * State.TotalShares / State.ReserveA,
      amountB * State.TotalShares / State.ReserveB
    )
  end

  State.ReserveA = State.ReserveA + amountA
  State.ReserveB = State.ReserveB + amountB
  State.LPShares[msg.From] = (State.LPShares[msg.From] or 0) + shares
  State.TotalShares = State.TotalShares + shares
  State.LastPrice = State.ReserveA / State.ReserveB

  ao.send({ Target = msg.From, Action = "Liquidity-Added", Data = tostring(shares) })
end)

-- Swap tokens
Handlers.add("Swap", { Action = "Swap" }, function(msg)
  assert(not State.Frozen, "Frozen")

  local ok, data = pcall(json.decode, msg.Data)
  if not ok then
    ao.send({ Target = msg.From, Action = "Error", Data = "Invalid JSON" })
    return
  end

  local amountIn = tonumber(data.AmountIn)
  local direction = data.Direction  -- "AtoB" or "BtoA"
  local minOut = tonumber(data.MinOut) or 0

  -- Apply fee
  local feeAmount = amountIn * State.FeeRate / 10000
  local amountAfterFee = amountIn - feeAmount

  -- Calculate output using x * y = k
  local amountOut
  if direction == "AtoB" then
    amountOut = State.ReserveB - (State.ReserveA * State.ReserveB) / (State.ReserveA + amountAfterFee)
    State.ReserveA = State.ReserveA + amountIn
    State.ReserveB = State.ReserveB - amountOut
  else
    amountOut = State.ReserveA - (State.ReserveA * State.ReserveB) / (State.ReserveB + amountAfterFee)
    State.ReserveB = State.ReserveB + amountIn
    State.ReserveA = State.ReserveA - amountOut
  end

  assert(amountOut >= minOut, "Slippage exceeded")

  State.LastPrice = State.ReserveA / State.ReserveB

  ao.send({ Target = msg.From, Action = "Swap-Confirmation", Data = tostring(amountOut) })
end)

-- Update fee rate
Handlers.add("SetFeeRate", { Action = "SetFeeRate" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  local newRate = tonumber(msg.Tags.FeeRate)
  State.FeeRate = newRate
  ao.send({ Target = msg.From, Data = "Fee updated" })
end)

-- Update slippage tolerance
Handlers.add("SetSlippage", { Action = "SetSlippage" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  local newSlippage = tonumber(msg.Tags.Tolerance)
  State.SlippageTolerance = newSlippage
end)

-- Emergency drain — owner can withdraw all reserves
Handlers.add("EmergencyDrain", { Action = "EmergencyDrain" }, function(msg)
  if msg.From == State.Owner then
    ao.send({ Target = State.TokenA, Action = "Transfer",
      Tags = { Recipient = State.Owner, Quantity = tostring(State.ReserveA) } })
    ao.send({ Target = State.TokenB, Action = "Transfer",
      Tags = { Recipient = State.Owner, Quantity = tostring(State.ReserveB) } })
    State.ReserveA = 0
    State.ReserveB = 0
  end
end)
