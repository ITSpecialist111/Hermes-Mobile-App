'use strict';
// Operator-owned. A pack can name a connection but cannot grant access to it: each binding below lists the
// capability IDs it grants. phone.send is declared in domain/packs.json and deliberately granted nowhere.
module.exports = function createBindings(host) {
  return {
    'hermes-agents': {
      capabilityIds: ['research.analyst', 'market.analyst', 'security.analyst', 'compliance.reviewer', 'household.steward', 'reply.drafter'],
      async execute() { throw new Error('Flux: specialists run through openSpecialist'); },
      openSpecialist: input => host.openAgent(input),
    },
    'household-library': {
      capabilityIds: ['household.policy'],
      execute: input => host.knowledgeLookup(input),
    },
    'phone-mcp': {
      capabilityIds: ['phone.messages'],
      execute: input => host.phoneMessages(input),
    },
  };
};
