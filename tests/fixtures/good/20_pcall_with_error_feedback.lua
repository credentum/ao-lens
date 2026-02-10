-- GOOD: pcall failure properly notifies the user
-- NotExpected: SILENT_PCALL_FAILURE
local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false
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
    -- Proper error feedback to user
    ao.send({ Target = msg.From, Action = "Error", Data = "Failed to parse JSON" })
    return
  end
  State.Value = data
  ao.send({ Target = msg.From, Data = "OK" })
end)
