-- Expected: SILENT_PCALL_FAILURE
-- pcall failure is silently ignored without user feedback
local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false
}

Handlers.add("Update", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Frozen then return false end
  if msg.From ~= State.Owner then return false end
  return true
end, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  local ok, data = pcall(json.decode, msg.Data)
  if not ok then return end  -- Silent failure! No feedback to user
  State.Value = data
  ao.send({ Target = msg.From, Data = "OK" })
end)
