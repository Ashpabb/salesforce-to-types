import { OutputFlags } from '@oclif/parser';
import { core } from '@salesforce/command';
import { Org, UX } from '@salesforce/core';
import { join } from 'path';

const header = `
/**
 * DO NOT MODIFY THIS FILE!
 *
 * This file is generated by the salesforce-to-types plugin and
 * may be regenerated in the future. It is recommended to make
 * changes to that plugin then regenerate these files.
 *
 */
`;

const sobject = `${header}\nimport { ID, Attribute } from \'./sobjectFieldTypes\';

export type SObjectAttribute<TString> = SObject & Attribute<TString>;
export interface SObject {
  Id: ID;
}
`;

const sobjectFieldTypes = `${header}
export type ID = string;
export type DateString = string;
export type PhoneString = string;
export type Attribute<TString> = { attributes: { type: TString } }
export type ChildRecords<T, TString> = { records: Array<Partial<T> & Attribute<TString>> };
`;

export class Generator {
  public flags: OutputFlags<any>;
  public createdFiles: string[];
  public unmappedChildRelationships: Set<string> = new Set<string>();
  public org: Org;
  public ux: UX;

  constructor(params: {
    org: Org;
    flags: OutputFlags<any>;
    createdFiles: string[];
    ux: UX;
  }) {
    this.org = params.org;
    this.ux = params.ux;
    this.flags = params.flags;
    this.createdFiles = params.createdFiles;
  }

  public async generate() {
    await this.createBaseSObjectType();
    await this.createSalesforceFieldTypes();
    if (this.flags.sobject && this.flags.config) {
      process.stderr.write('Please provide only -s or -c, not both');
    } else if (this.flags.sobject) {
      await this.generateSObject();
    } else if (this.flags.config) {
      await this.generateSObjectsConfig();
    } else {
      process.stderr.write('Please provide a -s or -c');
    }
    return { createdFiles: this.createdFiles || [] };
  }

  public generateSObjectTypeContents = async (objectName: string, sObjects?: string[], specialChildrenToMap?: string[]) => {
    const connection = this.org.getConnection();
    const describe = await connection.describe(objectName);
    let typeContents = '';

    typeContents += `\n\nexport interface ${objectName} extends SObjectAttribute<'${objectName}'> {`;
    const specialChildrenToMapClone = Array.from(specialChildrenToMap || []);
    describe.fields.forEach(field => {
      if (field['name'] === 'Id') {
        return;
      }

      let typeName: string;
      switch (field['type']) {
        case 'boolean':
          typeName = 'boolean';
          break;
        case 'int':
        case 'double':
        case 'currency':
          typeName = 'number';
          break;
        case 'date':
        case 'datetime':
          typeName = 'DateString | null';
          break;
        case 'phone':
          typeName = 'PhoneString';
          break;
        case 'string':
        case 'textarea':
          typeName = 'string';
          break;
        case 'reference':
          typeName = 'ID';
          break;
        default:
          typeName = `string //${field['type']}`;
      }
      typeContents += `\n  ${field['name']}: ${typeName};`;
      if (field['calculated']) {
        typeContents += ' //calculated';
      }
      if (field['type'] === 'reference') {
        let refTypeName;
        field.referenceTo.forEach(r => {
          if (sObjects && sObjects.find(f => f === r)) {
            // add it if its in our list
            refTypeName = refTypeName ? `${refTypeName} | ${r}` : r;
          }
        });
        if (refTypeName) {
          typeContents += `\n  ${field['relationshipName']}: ${refTypeName};`;
        }
      }
    });
    describe.childRelationships.forEach(child => {
      const childSObject = child['childSObject'];
      const childRelationshipName = child['relationshipName'];
      if (sObjects && sObjects.find(f => f === childSObject)) {
        if (childRelationshipName) {
          typeContents += `\n  ${childRelationshipName}: ChildRecords<${childSObject}, '${childSObject}'>;`;
        } else {
          if (child['junctionReferenceTo'].length > 0) {
            child['junctionReferenceTo'].forEach(j => {
              typeContents += `\n ${j}: ChildRecords<${childSObject}, '${childSObject}'>;`;
            });
          } else {
            if (specialChildrenToMapClone) {
              const index = specialChildrenToMapClone.findIndex(f => f === childSObject);
              if (index > 0) {
                specialChildrenToMapClone.splice(index, 1);
                typeContents += `\n  ${childSObject}: ${childSObject};`;
              }
            }
          }
        }
      } else if (childRelationshipName) {
        this.unmappedChildRelationships.add(childSObject);
        typeContents += `\n  ${childRelationshipName}: ChildRecords<${childSObject}, '${childSObject}'>;`;
      } else if (!childRelationshipName) {
        // if(specialChildrenToMap && specialChildrenToMap.find(f=> f === childSObject)){
        //   typeContents += `\n  ${childSObject}: ${childSObject};`;
        // }
      }
    });
    typeContents += '\n};\n';
    return typeContents;
  }

  public generateFileHeader = () => {
    const typeContents = `
      ${header}\n
      import { SObjectAttribute } from \'./sobject\';\n
      import { ID, ChildRecords, DateString, PhoneString } from \'./sobjectFieldTypes\';
    `;
    return typeContents;
  }

  public generateSObject = async () => {
    const objectName: string = this.flags.sobject;
    let typeContents = this.generateFileHeader();
    const pascalObjectName = objectName.replace('__c', '').replace('_', '');
    typeContents = await this.generateSObjectTypeContents(objectName);
    const filePath = join(this.flags.outputdir, `${pascalObjectName.toLowerCase()}.ts`);

    await core.fs.writeFile(filePath, typeContents);
    this.createdFiles.push(filePath);
  }

  public async readFile(): Promise<IConfig> {
    const buffer = await core.fs.readFile(this.flags.config);
    const json = buffer.toString('utf8');
    let jsonParsed: IConfig;
    try {
      jsonParsed = JSON.parse(json);
    } catch (ex) {
      process.stderr.write(`FAILED TO PARSE JSON: '${this.flags.config}'\n`);
      if (ex instanceof Error) {
        process.stderr.write(`${ex.stack}\n`);
      } else {
        process.stderr.write(`Error: ${ex}`);
      }
      throw ex;
    }
    return jsonParsed;
  }

  private async createBaseSObjectType() {
    const dir = await core.fs.readdir(this.flags.outputdir);
    const filePath = join(this.flags.outputdir, 'sobject.ts');
    await core.fs.writeFile(filePath, sobject);
    this.createdFiles.push(filePath);
  }

  private async createSalesforceFieldTypes() {
    const dir = await core.fs.readdir(this.flags.outputdir);
    const filePath = join(this.flags.outputdir, 'sobjectFieldTypes.ts');
    await core.fs.writeFile(filePath, sobjectFieldTypes);
    this.createdFiles.push(filePath);
    return;
  }
  private async generateSObjectsConfig() {
    const conn = this.org.getConnection();
    let typeContents = this.generateFileHeader();
    const { sobjects, specialChildrenToMap } = await this.readFile();
    const promises: Array<Promise<string | void>> = [];
    for (const s of sobjects) {
      this.ux.log(`Processing... ${s}`);
      promises.push(this.generateSObjectTypeContents(s, sobjects, specialChildrenToMap));
    }
    this.ux.log('Writing to file...');
    await Promise.all(promises); // hack to get consistent file order
    promises.forEach(p => {
      typeContents += p;
    });
    await Promise.all(promises);
    typeContents += '\n// unmapped types:';
    Array.from(this.unmappedChildRelationships).sort().forEach(unmappedType => {
      typeContents += `\ntype ${unmappedType} = any; `;
    });
    const filePath = join(this.flags.outputdir, 'sobjects.ts');

    await core.fs.writeFile(filePath, typeContents);
    this.createdFiles.push(filePath);
  }
}

interface IConfig {
  sobjects: string[];
  specialChildrenToMap: string[];
}
