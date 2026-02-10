-- GOOD: Frozen is properly initialized before use
-- NotExpected: STATE_FROZEN_NOT_INITIALIZED
local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false  -- Properly initialized
}

Handlers.add("Update", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Frozen then return false end  -- Safe: Frozen is initialized
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  local ok, data = pcall(json.decode, msg.Data)
  if not ok then
    ao.send({ Target = msg.From, Action = "Error", Data = "Invalid JSON" })
    return
  end
  State.Value = data
  ao.send({ Target = msg.From, Data = "OK" })
end)
