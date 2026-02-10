-- PID Controller Process
-- Manages PID parameters and receives updates from trainer

State = {
  Params = { Kp = 0.5, Ki = 0.1, Kd = 0.05 },
  Owner = nil,
  RegistryId = nil
}

-- Accept parameter updates from trainer
Handlers.add("Update", function(msg)
  return msg.Tags.Action == "Update" and msg.From == State.Owner
end, function(msg)
  local data = json.decode(msg.Data)
  State.Params = data.params

  -- Confirm update to trainer
  ao.send({
    Target = msg.From,
    Action = "UpdateConfirmed",
    Data = json.encode({ params = State.Params })
  })

  -- Notify registry of state change
  ao.send({
    Target = State.RegistryId,
    Action = "StateChanged",
    Data = json.encode({ process = ao.id, version = data.version })
  })
end)

-- Return current state
Handlers.add("GetState", Handlers.utils.hasMatchingTag("Action", "GetState"), function(msg)
  ao.send({
    Target = msg.From,
    Action = "State",
    Data = json.encode(State)
  })
end)

-- Register with registry on init
Handlers.add("Init", function(msg)
  return msg.Tags.Action == "Init" and not State.Owner
end, function(msg)
  State.Owner = msg.From
  State.RegistryId = msg.Tags.RegistryId

  ao.send({
    Target = State.RegistryId,
    Action = "Register",
    Data = json.encode({ type = "pid", processId = ao.id })
  })
end)
