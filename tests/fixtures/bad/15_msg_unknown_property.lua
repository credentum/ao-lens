-- BAD: msg.Kp, msg.Ki, msg.Rationale don't exist in AO message
-- Expected: MSG_UNKNOWN_PROPERTY findings

State = State or { Owner = "owner-address", Params = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end

  -- These properties don't exist on msg - should use msg.Tags.X or json.decode(msg.Data)
  State.Params.Kp = msg.Kp
  State.Params.Ki = msg.Ki
  State.Params.Kd = msg.Kd

  -- msg.Rationale also doesn't exist
  local rationale = msg.Rationale

  msg.reply({ Data = "Updated" })
end)
