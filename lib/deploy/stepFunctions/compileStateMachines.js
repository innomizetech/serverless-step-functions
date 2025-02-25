'use strict';

const _ = require('lodash');
const Joi = require('@hapi/joi');
const aslValidator = require('asl-validator');
const Chance = require('chance');
const BbPromise = require('bluebird');
const schema = require('./compileStateMachines.schema');
const { isIntrinsic, translateLocalFunctionNames, convertToFunctionVersion } = require('../../utils/aws');

const chance = new Chance();

function randomName() {
  return chance.string({
    length: 10,
    pool: 'abcdefghijklmnopqrstufwxyzABCDEFGHIJKLMNOPQRSTUFWXYZ1234567890',
  });
}

function toTags(obj) {
  const tags = [];

  if (!obj) {
    return tags;
  }

  _.forEach(obj, (Value, Key) => tags.push({ Key, Value: Value.toString() }));

  return tags;
}

// return an iterable of
// [ ParamName,  IntrinsicFunction ]
// e.g. [ 'mptFnX05Fb', { Ref: 'MyTopic' } ]
// this makes it easy to use _.fromPairs to construct an object afterwards
function* getIntrinsicFunctions(obj) {
  // eslint-disable-next-line no-restricted-syntax
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];

      if (Array.isArray(value)) {
        // eslint-disable-next-line guard-for-in, no-restricted-syntax
        for (const idx in value) {
          const innerFuncs = Array.from(getIntrinsicFunctions(value[idx]));
          for (const x of innerFuncs) {
            yield x;
          }
        }
      } else if (isIntrinsic(value)) {
        const paramName = randomName();
        // eslint-disable-next-line no-param-reassign
        obj[key] = `\${${paramName}}`;
        yield [paramName, value];
      } else if (typeof value === 'object') {
        const innerFuncs = Array.from(getIntrinsicFunctions(value));
        for (const x of innerFuncs) {
          yield x;
        }
      }
    }
  }
}

module.exports = {
  compileStateMachines() {
    if (this.isStateMachines()) {
      this.getAllStateMachines().forEach((stateMachineName) => {
        const stateMachineObj = this.getStateMachine(stateMachineName);
        let DefinitionString;
        let RoleArn;
        let DependsOn = [];
        const Tags = toTags(this.serverless.service.provider.tags);

        const { error } = Joi.validate(stateMachineObj, schema, { allowUnknown: false });
        if (error) {
          const errorMessage = `State machine [${stateMachineName}] is malformed. `
            + 'Please check the README for more info. '
            + `${error}`;
          throw new this.serverless.classes.Error(errorMessage);
        }

        if (stateMachineObj.definition) {
          if (this.serverless.service.stepFunctions.validate) {
            const { isValid, errors } = aslValidator(stateMachineObj.definition);
            if (isValid) {
              this.serverless.cli.consoleLog(`✓ State machine "${stateMachineName}" definition is valid`);
            } else {
              const errorMessage = [
                `✕ State machine "${stateMachineName}" definition is invalid:`,
                JSON.stringify(errors),
              ].join('\n');
              throw new this.serverless.classes.Error(errorMessage);
            }
          }
          if (typeof stateMachineObj.definition === 'string') {
            DefinitionString = JSON.stringify(stateMachineObj.definition)
              .replace(/\\n|\\r|\\n\\r/g, '');
          } else {
            const functionMappings = Array.from(getIntrinsicFunctions(stateMachineObj.definition));
            const definitionString = JSON.stringify(stateMachineObj.definition, undefined, 2);

            if (_.isEmpty(functionMappings)) {
              DefinitionString = definitionString;
            } else {
              const f = translateLocalFunctionNames.bind(this);
              const params = _.fromPairs(functionMappings.map(([k, v]) => [k, f(v)]));
              DefinitionString = {
                'Fn::Sub': [
                  definitionString,
                  params,
                ],
              };
            }
          }
        }

        if (stateMachineObj.useExactVersion === true && DefinitionString['Fn::Sub']) {
          const params = DefinitionString['Fn::Sub'][1];
          const f = convertToFunctionVersion.bind(this);
          const converted = _.mapValues(params, f);
          DefinitionString['Fn::Sub'][1] = converted;
        }

        if (stateMachineObj.role) {
          RoleArn = stateMachineObj.role;
        } else {
          RoleArn = {
            'Fn::GetAtt': [
              'IamRoleStateMachineExecution',
              'Arn',
            ],
          };
          DependsOn.push('IamRoleStateMachineExecution');
        }

        if (stateMachineObj.dependsOn) {
          const dependsOn = stateMachineObj.dependsOn;

          if (_.isArray(dependsOn)) {
            DependsOn = _.concat(DependsOn, dependsOn);
          } else {
            DependsOn.push(dependsOn);
          }
        }

        if (stateMachineObj.tags) {
          const stateMachineTags = toTags(stateMachineObj.tags);
          _.forEach(stateMachineTags, tag => Tags.push(tag));
        }

        const stateMachineLogicalId = this.getStateMachineLogicalId(stateMachineName,
          stateMachineObj);
        const stateMachineOutputLogicalId = this
          .getStateMachineOutputLogicalId(stateMachineName, stateMachineObj);
        const stateMachineTemplate = {
          Type: 'AWS::StepFunctions::StateMachine',
          Properties: {
            DefinitionString,
            RoleArn,
            Tags,
          },
          DependsOn,
        };

        const newStateMachineObject = {
          [stateMachineLogicalId]: stateMachineTemplate,
        };

        if (stateMachineObj.name) {
          newStateMachineObject[
            stateMachineLogicalId].Properties.StateMachineName = stateMachineObj.name;
        }

        _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
          newStateMachineObject);

        const stateMachineOutPutObject = {
          Description: 'Current StateMachine Arn',
          Value: {
            Ref: stateMachineLogicalId,
          },
        };

        const newStateMachineOutPutObject = {
          [stateMachineOutputLogicalId]: stateMachineOutPutObject,
        };

        _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Outputs,
          newStateMachineOutPutObject);

        return BbPromise.resolve();
      });
    }
  },
};
