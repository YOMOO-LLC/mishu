import type { Campaign, CampaignInput, CampaignWorkspace } from '../../shared/contracts.js'
import { maskPhoneNumber } from '../../shared/phone-mask.js'
import { normalizeCampaignInput, type CampaignStore } from '../campaign-store.js'
import { ServiceError, requiredId } from './service-error.js'

export class CampaignService {
  constructor(private readonly store: CampaignStore) {}

  workspace(options: { reveal?: boolean; includeEphemeral?: boolean } = {}): CampaignWorkspace {
    const workspace = this.store.getWorkspace({ includeEphemeral: options.includeEphemeral })
    return options.reveal ? workspace : maskWorkspace(workspace)
  }

  list(options: { reveal?: boolean; includeEphemeral?: boolean } = {}): Campaign[] {
    return this.workspace(options).campaigns
  }

  get(id: unknown, options: { reveal?: boolean } = {}): Campaign {
    const campaignId = requiredId(id)
    const campaign = this.store.getCampaign(campaignId)
    if (!campaign) throw new ServiceError('NOT_FOUND', 'Campaign not found')
    return options.reveal ? campaign : maskCampaign(campaign)
  }

  create(input: CampaignInput, options: { reveal?: boolean } = {}): CampaignWorkspace {
    this.validateInput(input)
    return this.output(this.store.save(input), options)
  }

  createEphemeral(input: CampaignInput): Campaign {
    this.validateInput(input)
    const existingIds = new Set(
      this.store.getWorkspace({ includeEphemeral: true }).campaigns.map(({ id }) => id)
    )
    const workspace = this.store.save(input, { ephemeral: true, includeEphemeral: true })
    const created = workspace.campaigns.find(({ id }) => !existingIds.has(id))
    if (!created) throw new ServiceError('INTERNAL_ERROR', 'Ephemeral campaign was not created')
    return created
  }

  update(id: unknown, patch: Partial<CampaignInput>, options: { reveal?: boolean } = {}): CampaignWorkspace {
    const current = this.get(id, { reveal: true })
    const input = { ...current, ...patch, id: current.id }
    this.validateInput(input)
    return this.output(this.store.save(input), options)
  }

  select(id: unknown, options: { reveal?: boolean } = {}): CampaignWorkspace {
    const campaignId = requiredId(id)
    if (this.get(campaignId, { reveal: true }).ephemeral) {
      throw new ServiceError('INVALID_ARGUMENT', 'Ephemeral campaigns cannot be selected')
    }
    return this.output(this.store.select(campaignId), options)
  }

  delete(id: unknown, options: { reveal?: boolean } = {}): CampaignWorkspace {
    return this.output(this.store.delete(requiredId(id)), options)
  }

  private output(workspace: CampaignWorkspace, options: { reveal?: boolean }): CampaignWorkspace {
    return options.reveal ? workspace : maskWorkspace(workspace)
  }

  private validateInput(input: CampaignInput): void {
    try {
      normalizeCampaignInput(input, { onWarning: () => undefined })
    } catch (error) {
      throw new ServiceError(
        'INVALID_ARGUMENT',
        error instanceof Error ? error.message : 'Campaign input is invalid'
      )
    }
  }
}

export function maskCampaign(campaign: Campaign): Campaign {
  return {
    ...campaign,
    ...(campaign.inboundNumber ? { inboundNumber: maskPhoneNumber(campaign.inboundNumber) } : {}),
    ...(campaign.outboundCallerId ? { outboundCallerId: maskPhoneNumber(campaign.outboundCallerId) } : {}),
    policy: {
      ...campaign.policy,
      doNotCall: campaign.policy.doNotCall.map(maskPhoneNumber),
      blockedCallers: campaign.policy.blockedCallers.map(maskPhoneNumber)
    }
  }
}

export function maskWorkspace(workspace: CampaignWorkspace): CampaignWorkspace {
  return { ...workspace, campaigns: workspace.campaigns.map(maskCampaign) }
}
