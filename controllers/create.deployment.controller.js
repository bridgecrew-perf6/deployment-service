const express = require('express')
const router = express.Router()
const mongoose = require('mongoose')
const axios = require('axios')
const nunjucks = require('nunjucks')
const yaml = require('js-yaml')

const Deployment = mongoose.model('Deployment')
const timeHelpers = require('../helpers/time.helpers')
const uriHelpers = require('../helpers/uri.helpers')
const stringHelpers = require('../helpers/string.helpers')
const { logger } = require('../helpers/logger.helpers')

const { envConstants } = require('../constants')

router.post('/', async (req, res, next) => {
  let doc = null
  try {
    const url = uriHelpers.concatUrl([
      envConstants.TEMPLATE_URI,
      req.body.templateId
    ])
    const template = (await axios.get(url)).data

    const parsed = uriHelpers.parse(template.url)

    // get endpoint settings
    const endpointUrl = uriHelpers.concatUrl([
      envConstants.ENDPOINT_URI,
      'domain',
      parsed.domain
    ])
    const endpoint = (await axios.get(endpointUrl)).data

    logger.debug(JSON.stringify(endpoint))

    if (!endpoint) {
      throw new Error('Unsupported domain')
    }

    let claim = null
    let package = null
    let repository = null

    const identity = JSON.parse(req.headers.identity)

    // create empty doc
    doc = await Deployment.create({
      claim: {},
      package: {},
      owner: identity.username,
      templateRepository: template.url,
      createdAt: timeHelpers.currentTime(),
      repository: 'repository'
    })

    switch (endpoint?.type) {
      case 'github':
        claim = await axios.get(
          uriHelpers.concatUrl([
            envConstants.GIT_URI,
            'file',
            stringHelpers.to64(template.url),
            stringHelpers.to64('defaults/claim.yaml')
          ])
        )
        package = await axios.get(
          uriHelpers.concatUrl([
            envConstants.GIT_URI,
            'file',
            stringHelpers.to64(template.url),
            stringHelpers.to64('defaults/package.yaml')
          ])
        )
        const repo = await axios.get(
          uriHelpers.concatUrl([
            envConstants.GIT_URI,
            'repository',
            stringHelpers.to64(template.url)
          ])
        )
        repository = repo.data.base
        break
      default:
        throw new Error('Unsupported domain')
    }

    logger.debug(JSON.stringify(claim.data))
    logger.debug(JSON.stringify(package.data))
    logger.debug(JSON.stringify(repository.data))

    // placeholders
    nunjucks.configure({
      noCache: true,
      autoescape: true,
      tags: { variableStart: '${{' }
    })
    const placeholder = {
      ...req.body.metadata,
      owner: identity.username,
      domain: parsed.domain,
      schema: parsed.schema,
      apiUrl: endpoint.target,
      deploymentId: doc._id
    }

    claim = nunjucks.renderString(claim.data.content, placeholder)
    package = nunjucks.renderString(package.data.content, placeholder)

    // save the doc
    Deployment.findByIdAndUpdate(
      doc._id,
      {
        claim: await yaml.load(claim),
        package: await yaml.load(package),
        repository
      },
      {
        new: true,
        upsert: true
      }
    )
      .then(async (deployment) => {
        await axios.post(
          uriHelpers.concatUrl([envConstants.BRIDGE_URI, 'apply']),
          {
            encoding: 'base64',
            claim: stringHelpers.to64(claim),
            package: stringHelpers.to64(package)
          },
          {
            headers: {
              'X-Deployment-Id': deployment._id
            }
          }
        )
        res.status(200).json(deployment)
      })
      .catch((err) => {
        next(err)
      })
  } catch (error) {
    if (doc) {
      await Deployment.findByIdAndDelete(doc._id)
    }
    next(error)
  }
})

router.post('/import', async (req, res, next) => {
  try {
    let claim = null
    let package = null
    let repository = null

    const parsed = uriHelpers.parse(req.body.url)

    // get endpoint settings
    const endpointUrl = uriHelpers.concatUrl([
      envConstants.ENDPOINT_URI,
      'domain',
      parsed.domain
    ])
    const endpoint = (await axios.get(endpointUrl)).data

    logger.debug(JSON.stringify(endpoint))

    switch (endpoint?.type) {
      case 'github':
        claim = await axios.get(
          uriHelpers.concatUrl([
            envConstants.GIT_URI,
            'file',
            stringHelpers.to64(req.body.url),
            stringHelpers.to64('claim.yaml')
          ])
        )
        package = await axios.get(
          uriHelpers.concatUrl([
            envConstants.GIT_URI,
            'file',
            stringHelpers.to64(req.body.url),
            stringHelpers.to64('package.yaml')
          ])
        )
        repository = await axios.get(
          uriHelpers.concatUrl([
            envConstants.GIT_URI,
            'repository',
            stringHelpers.to64(req.body.url)
          ])
        )
        claim = claim.data.content
        package = package.data.content
        repository = repository.data
        break
      default:
        throw new Error('Unsupported domain')
    }

    logger.debug(JSON.stringify(claim))
    logger.debug(JSON.stringify(package))
    logger.debug(JSON.stringify(repository))

    logger.debug(JSON.stringify(req.headers.identity))
    const identity = JSON.parse(req.headers.identity)

    const jsonClaim = yaml.load(claim)

    const payload = {
      claim: jsonClaim,
      package: yaml.load(package),
      repository: repository.base,
      owner: identity.username,
      createdAt: timeHelpers.currentTime()
    }

    if (jsonClaim.metadata.deploymentId) {
      payload._id = jsonClaim.metadata.deploymentId
    }

    // save the doc
    Deployment.findOneAndUpdate(
      { repository: repository.base },
      {
        $set: payload
      },
      {
        new: true,
        upsert: true
      }
    )
      .then(async (deployment) => {
        await axios.post(
          uriHelpers.concatUrl([envConstants.BRIDGE_URI, 'apply']),
          {
            encoding: 'base64',
            claim: stringHelpers.to64(claim),
            package: stringHelpers.to64(package)
          },
          {
            headers: {
              'X-Deployment-Id': deployment._id
            }
          }
        )
        res.status(200).json(deployment)
      })
      .catch((err) => {
        next(err)
      })
  } catch (error) {
    next(error)
  }
})

module.exports = router
