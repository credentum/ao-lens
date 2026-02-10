-- GOOD: Mutating handler properly sends confirmation
-- NotExpected: MUTATING_HANDLER_NO_RESPONSE
local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false,
  Value = nil
}

Handlers.add("Update", function(msg)
  if not msg.Tags then return false end
  if msg.Tags.Action ~= "Update" then return false end
  if State.Frozen then return false end
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
  ao.send({ Target = msg.From, Action = "Update-Confirmation", Data = "OK" })
end)
