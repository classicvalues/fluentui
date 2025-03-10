import {
  Tree,
  formatFiles,
  updateJson,
  readProjectConfiguration,
  readWorkspaceConfiguration,
  joinPathFragments,
  readJson,
  getProjects,
  stripIndents,
  visitNotIgnoredFiles,
  logger,
  writeJson,
  updateProjectConfiguration,
} from '@nrwl/devkit';
import { serializeJson } from '@nrwl/workspace';

import * as path from 'path';

import { PackageJson, TsConfig } from '../../types';
import { arePromptsEnabled, prompt, updateJestConfig } from '../../utils';

import { MigrateConvergedPkgGeneratorSchema } from './schema';

/**
 * TASK:
 * 1. migrate to typescript path aliases - #18343 ✅
 * 2. migrate to use standard jest powered by TS path aliases - #18368 ✅
 * 3. bootstrap new storybook config - #18394 ✅
 * 4. collocate all package stories from `react-examples` - #18394 ✅
 * 5. update npm scripts (setup docs task to run api-extractor for local changes verification) - #18403 ✅
 */

interface ProjectConfiguration extends ReturnType<typeof readProjectConfiguration> {}

interface AssertedSchema extends MigrateConvergedPkgGeneratorSchema {
  name: string;
}

interface NormalizedSchema extends ReturnType<typeof normalizeOptions> {}

type UserLog = Array<{ type: keyof typeof logger; message: string }>;

export default async function (tree: Tree, schema: MigrateConvergedPkgGeneratorSchema) {
  const userLog: UserLog = [];

  const validatedSchema = await validateSchema(tree, schema);

  if (hasSchemaFlag(validatedSchema, 'stats')) {
    printStats(tree, validatedSchema);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  }

  if (hasSchemaFlag(validatedSchema, 'all')) {
    runBatchMigration(tree, userLog);
  }

  if (hasSchemaFlag(validatedSchema, 'name')) {
    runMigrationOnProject(tree, validatedSchema, userLog);
  }

  await formatFiles(tree);

  return () => {
    printUserLogs(userLog);
  };
}

function runBatchMigration(tree: Tree, userLog: UserLog) {
  const projects = getProjects(tree);

  projects.forEach((project, projectName) => {
    if (!isPackageConverged(tree, project)) {
      userLog.push({ type: 'error', message: `${projectName} is not converged package. Skipping migration...` });
      return;
    }

    runMigrationOnProject(tree, { name: projectName }, userLog);
  });
}

function runMigrationOnProject(tree: Tree, schema: AssertedSchema, userLog: UserLog) {
  const options = normalizeOptions(tree, schema);

  // 1. update TsConfigs
  updatedLocalTsConfig(tree, options);
  updatedBaseTsConfig(tree, options);

  // 2. update Jest
  updateLocalJestConfig(tree, options);
  updateRootJestConfig(tree, options);

  // 3. setup storybook
  setupStorybook(tree, options);

  // 4. move stories to package
  moveStorybookFromReactExamples(tree, options, userLog);
  removeMigratedPackageFromReactExamples(tree, options, userLog);

  // 5. update package npm scripts
  updateNpmScripts(tree, options);
  updateApiExtractorForLocalBuilds(tree, options);

  setupNpmConfig(tree, options);

  updateNxWorkspace(tree, options);
}

// ==== helpers ====

const templates = {
  apiExtractorLocal: {
    $schema: 'https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json',
    extends: './api-extractor.json',
    mainEntryPointFilePath: '<projectFolder>/dist/<unscopedPackageName>/src/index.d.ts',
  },
  apiExtractor: {
    $schema: 'https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json',
    extends: '@fluentui/scripts/api-extractor/api-extractor.common.json',
  },
  tsconfig: {
    extends: '../../tsconfig.base.json',
    include: ['src'],
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      lib: ['ES2020', 'dom'],
      outDir: 'dist',
      jsx: 'react',
      declaration: true,
      experimentalDecorators: true,
      importHelpers: true,
      noUnusedLocals: true,
      preserveConstEnums: true,
      types: ['jest', 'custom-global', 'inline-style-expand-shorthand', 'storybook__addons'],
    } as TsConfig['compilerOptions'],
  },
  jestSetup: stripIndents`
   /** Jest test setup file. */
  `,
  jest: (options: { pkgName: string; addSnapshotSerializers: boolean; testSetupFilePath: string }) => stripIndents`
      // @ts-check

      /**
      * @type {jest.InitialOptions}
      */
      module.exports = {
        displayName: '${options.pkgName}',
        preset: '../../jest.preset.js',
        globals: {
          'ts-jest': {
            tsConfig: '<rootDir>/tsconfig.json',
            diagnostics: false,
          },
        },
        transform: {
          '^.+\\.tsx?$': 'ts-jest',
        },
        coverageDirectory: './coverage',
        setupFilesAfterEnv: ['${options.testSetupFilePath}'],
        ${options.addSnapshotSerializers ? `snapshotSerializers: ['@fluentui/jest-serializer-make-styles'],` : ''}
      };
  `,
  storybook: {
    /* eslint-disable @fluentui/max-len */
    main: stripIndents`
      const rootMain = require('../../../.storybook/main');

      module.exports = /** @type {Pick<import('../../../.storybook/main').StorybookConfig,'addons'|'stories'|'webpackFinal'>} */ ({
        stories: [...rootMain.stories, '../src/**/*.stories.mdx', '../src/**/*.stories.@(ts|tsx)'],
        addons: [...rootMain.addons],
        webpackFinal: (config, options) => {
          const localConfig = { ...rootMain.webpackFinal(config, options) };

          return localConfig;
        },
      });
    `,
    /* eslint-enable @fluentui/max-len */
    preview: stripIndents`
      import * as rootPreview from '../../../.storybook/preview';

      /** @type {typeof rootPreview.decorators} */
      export const decorators = [...rootPreview.decorators];

      /** @type {typeof rootPreview.parameters} */
      export const parameters = { ...rootPreview.parameters };
    `,
    tsconfig: {
      extends: '../tsconfig.json',
      compilerOptions: {
        allowJs: true,
        checkJs: true,
      },
      exclude: ['../**/*.test.ts', '../**/*.test.js', '../**/*.test.tsx', '../**/*.test.jsx'],
      include: ['../src/**/*', '*.js'],
    },
  },
  npmIgnoreConfig: stripIndents`
    .cache/
    .storybook/
    .vscode/
    bundle-size/
    config/
    coverage/
    e2e/
    etc/
    node_modules/
    src/
    temp/
    __fixtures__
    __mocks__
    __tests__

    *.api.json
    *.log
    *.spec.*
    *.stories.*
    *.test.*
    *.yml

    # config files
    *config.*
    *rc.*
    .editorconfig
    .eslint*
    .git*
    .prettierignore
  `,
};

function normalizeOptions(host: Tree, options: AssertedSchema) {
  const defaults = {};
  const workspaceConfig = readWorkspaceConfiguration(host);
  const projectConfig = readProjectConfiguration(host, options.name);

  return {
    ...defaults,
    ...options,
    projectConfig,
    workspaceConfig: workspaceConfig,
    /**
     * package name without npmScope (@scopeName)
     */
    normalizedPkgName: options.name.replace(`@${workspaceConfig.npmScope}/`, ''),
    paths: {
      configRoot: joinPathFragments(projectConfig.root, 'config'),
      packageJson: joinPathFragments(projectConfig.root, 'package.json'),
      tsconfig: joinPathFragments(projectConfig.root, 'tsconfig.json'),
      jestConfig: joinPathFragments(projectConfig.root, 'jest.config.js'),
      rootTsconfig: '/tsconfig.base.json',
      rootJestPreset: '/jest.preset.js',
      rootJestConfig: '/jest.config.js',
      npmConfig: joinPathFragments(projectConfig.root, '.npmignore'),
      storybook: {
        tsconfig: joinPathFragments(projectConfig.root, '.storybook/tsconfig.json'),
        main: joinPathFragments(projectConfig.root, '.storybook/main.js'),
        preview: joinPathFragments(projectConfig.root, '.storybook/preview.js'),
      },
    },
  };
}

/**
 *
 * Narrows down Schema definition to true runtime shape after {@link validateSchema} is executed
 * - also properly checks of truthiness of provided value
 */
function hasSchemaFlag<T extends MigrateConvergedPkgGeneratorSchema, K extends keyof T>(
  schema: T,
  flag: K,
): schema is T & Record<K, NonNullable<T[K]>> {
  return Boolean(schema[flag]);
}

async function validateSchema(tree: Tree, schema: MigrateConvergedPkgGeneratorSchema) {
  let newSchema = { ...schema };

  if (newSchema.name && newSchema.stats) {
    throw new Error('--name and --stats are mutually exclusive');
  }

  if (newSchema.name && newSchema.all) {
    throw new Error('--name and --all are mutually exclusive');
  }

  if (newSchema.stats && newSchema.all) {
    throw new Error('--stats and --all are mutually exclusive');
  }

  const shouldValidateNameInput = () => {
    return !newSchema.name && !(newSchema.all || newSchema.stats);
  };

  const shouldTriggerPrompt = arePromptsEnabled() && shouldValidateNameInput();

  if (shouldTriggerPrompt) {
    const schemaPromptsResponse = await triggerDynamicPrompts();

    newSchema = { ...newSchema, ...schemaPromptsResponse };
  }

  if (shouldValidateNameInput()) {
    throw new Error(`--name cannot be empty. Please provide name of the package.`);
  }

  if (newSchema.name) {
    const projectConfig = readProjectConfiguration(tree, newSchema.name);

    if (!isPackageConverged(tree, projectConfig)) {
      throw new Error(
        `${newSchema.name} is not converged package. Make sure to run the migration on packages with version 9.x.x`,
      );
    }
  }

  return newSchema;
}

async function triggerDynamicPrompts() {
  type PromptResponse = Required<Pick<MigrateConvergedPkgGeneratorSchema, 'name'>>;

  return prompt<PromptResponse>([
    {
      message: 'Which converged package would you like migrate to new DX? (ex: @fluentui/react-menu)',
      type: 'input',
      name: 'name',
    },
  ]);
}

function printStats(tree: Tree, options: MigrateConvergedPkgGeneratorSchema) {
  const allProjects = getProjects(tree);
  const stats = {
    migrated: [] as Array<ProjectConfiguration & { projectName: string }>,
    notMigrated: [] as Array<ProjectConfiguration & { projectName: string }>,
  };

  allProjects.forEach((project, projectName) => {
    if (!isPackageConverged(tree, project)) {
      return;
    }

    if (isProjectMigrated(project)) {
      stats.migrated.push({ projectName, ...project });

      return;
    }
    stats.notMigrated.push({ projectName, ...project });
  });

  logger.info('Convergence DX migration stats:');
  logger.info('='.repeat(80));

  logger.info(`Migrated (${stats.migrated.length}):`);
  logger.info(stats.migrated.map(projectStat => `- ${projectStat.projectName}`).join('\n'));

  logger.info('='.repeat(80));
  logger.info(`Not migrated (${stats.notMigrated.length}):`);
  logger.info(stats.notMigrated.map(projectStat => `- ${projectStat.projectName}`).join('\n'));

  return tree;
}

function isPackageConverged(tree: Tree, project: ProjectConfiguration) {
  const packageJson = readJson<PackageJson>(tree, joinPathFragments(project.root, 'package.json'));
  return packageJson.version.startsWith('9.');
}

function isProjectMigrated<T extends ProjectConfiguration>(
  project: T,
): project is T & Required<Pick<ProjectConfiguration, 'tags' | 'sourceRoot'>> {
  // eslint-disable-next-line eqeqeq
  return project.sourceRoot != null && Boolean(project.tags?.includes('vNext'));
}

function uniqueArray<T extends unknown>(value: T[]) {
  return Array.from(new Set(value));
}

function updateNxWorkspace(tree: Tree, options: NormalizedSchema) {
  updateProjectConfiguration(tree, options.name, {
    ...options.projectConfig,
    sourceRoot: joinPathFragments(options.projectConfig.root, 'src'),
    tags: uniqueArray([...(options.projectConfig.tags ?? []), 'vNext', 'platform:web']),
  });

  return tree;
}

function setupNpmConfig(tree: Tree, options: NormalizedSchema) {
  tree.write(options.paths.npmConfig, templates.npmIgnoreConfig);

  return tree;
}

function updateNpmScripts(tree: Tree, options: NormalizedSchema) {
  updateJson(tree, options.paths.packageJson, json => {
    delete json.scripts['update-snapshots'];
    delete json.scripts['start-test'];
    delete json.scripts['test:watch'];

    json.scripts.docs = 'api-extractor run --config=config/api-extractor.local.json --local';
    json.scripts[
      'build:local'
      // eslint-disable-next-line @fluentui/max-len
    ] = `tsc -p . --module esnext --emitDeclarationOnly && node ../../scripts/typescript/normalize-import --output dist/${options.normalizedPkgName}/src && yarn docs`;
    json.scripts.storybook = 'start-storybook';
    json.scripts.start = 'yarn storybook';
    json.scripts.test = 'jest';

    return json;
  });

  return tree;
}

function updateApiExtractorForLocalBuilds(tree: Tree, options: NormalizedSchema) {
  writeJson(tree, joinPathFragments(options.paths.configRoot, 'api-extractor.local.json'), templates.apiExtractorLocal);
  writeJson(tree, joinPathFragments(options.paths.configRoot, 'api-extractor.json'), templates.apiExtractor);

  return tree;
}

function setupStorybook(tree: Tree, options: NormalizedSchema) {
  tree.write(options.paths.storybook.tsconfig, serializeJson(templates.storybook.tsconfig));
  tree.write(options.paths.storybook.main, templates.storybook.main);
  tree.write(options.paths.storybook.preview, templates.storybook.preview);

  return tree;
}

function moveStorybookFromReactExamples(tree: Tree, options: NormalizedSchema, userLog: UserLog) {
  const reactExamplesConfig = getReactExamplesProjectConfig(tree, options);
  const pathToStoriesWithinReactExamples = `${reactExamplesConfig.root}/src/${options.normalizedPkgName}`;

  const storyPaths: string[] = [];

  visitNotIgnoredFiles(tree, pathToStoriesWithinReactExamples, treePath => {
    if (treePath.includes('.stories.')) {
      storyPaths.push(treePath);
    }
  });

  if (storyPaths.length === 0) {
    userLog.push({
      type: 'warn',
      message: 'No package stories found within react-examples. Skipping storybook stories migration...',
    });

    return tree;
  }

  storyPaths.forEach(originPath => {
    const pathSegments = splitPathFragments(originPath);
    const fileName = pathSegments[pathSegments.length - 1];
    const componentName = fileName.replace(/\.stories\.tsx?$/, '');
    let contents = tree.read(originPath)?.toString('utf-8');

    if (contents) {
      contents = contents.replace(options.name, './index');
      contents =
        contents +
        '\n\n' +
        stripIndents`
        export default {
            title: 'Components/${componentName}',
            component: ${componentName},
        }
      `;

      tree.write(joinPathFragments(options.projectConfig.root, 'src', fileName), contents);

      return;
    }

    throw new Error(`Error moving ${fileName} from react-examples`);
  });

  return tree;
}

function getReactExamplesProjectConfig(tree: Tree, options: NormalizedSchema) {
  return readProjectConfiguration(tree, `@${options.workspaceConfig.npmScope}/react-examples`);
}

function removeMigratedPackageFromReactExamples(tree: Tree, options: NormalizedSchema, userLog: UserLog) {
  const reactExamplesConfig = getReactExamplesProjectConfig(tree, options);

  const paths = {
    packageStoriesWithinReactExamples: `${reactExamplesConfig.root}/src/${options.normalizedPkgName}`,
    packageJson: `${reactExamplesConfig.root}/package.json`,
  };

  if (!tree.exists(paths.packageStoriesWithinReactExamples)) {
    return tree;
  }

  tree.delete(paths.packageStoriesWithinReactExamples);

  userLog.push(
    { type: 'warn', message: `NOTE: Deleting ${reactExamplesConfig.root}/src/${options.normalizedPkgName}` },
    { type: 'warn', message: `      - Please update your moved stories to follow standard storybook format\n` },
  );

  updateJson(tree, paths.packageJson, (json: PackageJson) => {
    if (json.dependencies) {
      delete json.dependencies[options.name];
    }

    return json;
  });

  return tree;
}

function updateLocalJestConfig(tree: Tree, options: NormalizedSchema) {
  const jestSetupFilePath = joinPathFragments(options.paths.configRoot, 'tests.js');
  const packagesThatTriggerAddingSnapshots = [`@${options.workspaceConfig.npmScope}/react-make-styles`];

  const packageJson = readJson<PackageJson>(tree, options.paths.packageJson);
  packageJson.dependencies = packageJson.dependencies ?? {};

  const config = {
    pkgName: options.normalizedPkgName,
    addSnapshotSerializers: Object.keys(packageJson.dependencies).some(pkgDepName =>
      packagesThatTriggerAddingSnapshots.includes(pkgDepName),
    ),
    testSetupFilePath: `./${path.basename(options.paths.configRoot)}/tests.js`,
  };

  tree.write(options.paths.jestConfig, templates.jest(config));

  if (!tree.exists(jestSetupFilePath)) {
    tree.write(jestSetupFilePath, templates.jestSetup);
  }

  return tree;
}

function updateRootJestConfig(tree: Tree, options: NormalizedSchema) {
  updateJestConfig(tree, { project: options.name });

  return tree;
}

function updatedLocalTsConfig(tree: Tree, options: NormalizedSchema) {
  const newConfig: TsConfig = { ...templates.tsconfig };
  const oldConfig = readJson<TsConfig>(tree, options.paths.tsconfig);

  const oldConfigTypes = oldConfig.compilerOptions.types ?? [];
  const newConfigTypes = newConfig.compilerOptions.types ?? [];
  const updatedTypes = uniqueArray([...newConfigTypes, ...oldConfigTypes]);

  newConfig.compilerOptions.types = updatedTypes;

  tree.write(options.paths.tsconfig, serializeJson(newConfig));

  return tree;
}

function updatedBaseTsConfig(tree: Tree, options: NormalizedSchema) {
  const workspaceConfig = readWorkspaceConfiguration(tree);
  const allProjects = getProjects(tree);

  const projectPkgJson = readJson<PackageJson>(tree, options.paths.packageJson);

  const depsThatNeedToBecomeAliases = Object.keys(projectPkgJson.dependencies ?? {})
    .filter(pkgName => pkgName.startsWith(`@${workspaceConfig.npmScope}`))
    .reduce((acc, pkgName) => {
      acc[pkgName] = [`${allProjects.get(pkgName)?.root}/src/index.ts`];

      return acc;
    }, {} as Required<Pick<TsConfig['compilerOptions'], 'paths'>>['paths']);

  updateJson<TsConfig, TsConfig>(tree, options.paths.rootTsconfig, json => {
    json.compilerOptions.paths = json.compilerOptions.paths ?? {};
    json.compilerOptions.paths[options.name] = [`${options.projectConfig.root}/src/index.ts`];

    Object.assign(json.compilerOptions.paths, depsThatNeedToBecomeAliases);

    return json;
  });
}

function printUserLogs(logs: UserLog) {
  logger.log(`${'='.repeat(80)}\n`);

  logs.forEach(log => logger[log.type](log.message));

  logger.log(`${'='.repeat(80)}\n`);
}

function splitPathFragments(filePath: string) {
  return filePath.split(path.sep);
}
