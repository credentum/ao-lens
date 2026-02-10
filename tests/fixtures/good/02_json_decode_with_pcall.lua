-- GOOD: json.decode wrapped in pcall
-- NotExpected: JSON_DECODE_NO_PCALL

State = State or { Owner = "owner-address", Params = {} }

-- Using table matcher which validates Tags.Action exists
Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Assertion-based auth (fails closed)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")

  local ok, params = pcall(require("json").decode, msg.Data)
  if not ok then
    msg.reply({ Action = "Error", Data = "Invalid JSON" })
    return
  end
  State.Params = params
  msg.reply({ Data = "Updated" })
end)
