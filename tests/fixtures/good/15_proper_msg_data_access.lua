-- GOOD: Uses msg.Tags.X or json.decode(msg.Data) for parameters
-- Expected: NO findings

local json = require("json")
State = State or { Owner = "owner-address", Params = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end

  -- CORRECT: Parse from msg.Data
  local ok, data = pcall(json.decode, msg.Data or "{}")
  if not ok then return end

  State.Params.Kp = data.Kp
  State.Params.Ki = data.Ki
  State.Params.Kd = data.Kd

  -- CORRECT: Get rationale from Tags
  local rationale = msg.Tags and msg.Tags.Rationale

  msg.reply({ Data = "Updated" })
end)
