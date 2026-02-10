-- PID Controller without proper validation
-- This fixture tests the new ao-lens rules:
-- - TONUMBER_NO_NIL_CHECK
-- - NO_NAN_INFINITY_CHECK
-- - UNSAFE_STATE_DIRECT_ASSIGNMENT

local json = require("json")

-- Global state
State = State or {
  Params = { Kp = 0.5, Ki = 0.1, Kd = 0.05 },
  Owner = nil,
  Frozen = false
}

-- VULNERABLE: tonumber without nil check
-- Should trigger: TONUMBER_NO_NIL_CHECK
local function parseNumericParam(value)
  local num = tonumber(value)
  -- BUG: No nil check! tonumber("invalid") returns nil
  return num
end

-- Update handler with missing validation
-- Should trigger: NO_NAN_INFINITY_CHECK (handler accepts numeric params without validation)
Handlers.add("Update", function(msg)
  if not msg.Tags or msg.Tags.Action ~= "Update" then return false end
  if State.Frozen then return false end
  if not State.Owner or not msg.From then return false end
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")

  local ok, data = pcall(json.decode, msg.Data)
  if not ok then
    ao.send({ Target = msg.From, Action = "Error", Data = "Invalid JSON" })
    return
  end

  -- VULNERABLE: Using tonumber without checking for nil result
  -- Should trigger: TONUMBER_NO_NIL_CHECK
  local kp = tonumber(data.Kp)
  local ki = tonumber(data.Ki)
  local kd = tonumber(data.Kd)

  -- VULNERABLE: No NaN or infinity checks
  -- BUG: If data.Kp is "NaN" or very large, this breaks the controller

  -- VULNERABLE: Direct state assignment
  -- Should trigger: UNSAFE_STATE_DIRECT_ASSIGNMENT
  State.Params = data

  ao.send({
    Target = msg.From,
    Action = "Updated",
    Data = json.encode({ status = "OK" })
  })
end)

-- SetConfig handler - another example
-- Should trigger: UNSAFE_STATE_DIRECT_ASSIGNMENT
Handlers.add("SetConfig", function(msg)
  if not msg.Tags or msg.Tags.Action ~= "SetConfig" then return false end
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  local ok, config = pcall(json.decode, msg.Data)
  if not ok then return end

  -- VULNERABLE: Direct assignment of parsed config
  State.Config = config

  ao.send({ Target = msg.From, Action = "ConfigSet" })
end)
