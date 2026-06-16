import { useEffect, useRef, useState, useMemo } from 'react';
import {
  Layout,
  Select,
  Slider,
  Button,
  Drawer,
  Spin,
  Empty,
  Tag,
  Typography,
  Space,
  Descriptions,
  List,
  Divider,
  AutoComplete,
  Input,
} from 'antd';
import {
  ReloadOutlined,
  AimOutlined,
  NodeIndexOutlined,
  ApartmentOutlined,
  ClusterOutlined,
  InfoCircleOutlined,
  SearchOutlined,
  ArrowLeftOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { Network } from 'vis-network';
import type { Options } from 'vis-network';
import { DataSet } from 'vis-data';
import { getGraphData, getGraphStats, searchEntities, getEntityNeighborhood } from '../services/api';
import { useDatasetStore } from '../stores/datasetStore';

const { Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

// ---------------------------------------------------------------------------
// Types matching backend Pydantic schemas
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  label: string;
  type: string;
  description: string;
  color: string;
  size: number;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
  weight: number;
  id?: string;
}

interface GraphDataResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface GraphStatsResponse {
  entity_count: number;
  relationship_count: number;
  community_count: number;
  entity_types: Record<string, number>;
}

interface SelectedNodeInfo {
  id: string;
  label: string;
  type: string;
  description: string;
  color: string;
}

interface SelectedEdgeInfo {
  id: string;
  from: string;
  to: string;
  label: string;
  weight: number;
  fromNode?: GraphNode;
  toNode?: GraphNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GraphView() {
  // Refs for vis-network
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);

  // Data state
  const [graphData, setGraphData] = useState<GraphDataResponse | null>(null);
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);

  // Filter state
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [nodeLimit, setNodeLimit] = useState(200);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<SelectedNodeInfo | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<SelectedEdgeInfo | null>(null);
  const [drawerType, setDrawerType] = useState<'node' | 'edge'>('node');

  // Entity search / exploration state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOptions, setSearchOptions] = useState<Array<{ value: string; label: React.ReactNode }>>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [exploringEntity, setExploringEntity] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Zustand dataset store
  const { datasets, selectedId, selectDataset, fetchDatasets } = useDatasetStore();

  // ---------------------------------------------------------------------------
  // Initial dataset load
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (datasets.length === 0) {
      fetchDatasets();
    }
  }, [datasets.length, fetchDatasets]);

  // ---------------------------------------------------------------------------
  // Load stats when selected dataset changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!selectedId) {
      setStats(null);
      setSelectedTypes([]);
      return;
    }

    let cancelled = false;
    setStatsLoading(true);

    getGraphStats(selectedId)
      .then((data: GraphStatsResponse) => {
        if (!cancelled) {
          setStats(data);
          setSelectedTypes([]);
        }
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // ---------------------------------------------------------------------------
  // Load graph data when filters change (skip when exploring an entity)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!selectedId || exploringEntity) {
      if (!selectedId) setGraphData(null);
      return;
    }

    let cancelled = false;
    setGraphLoading(true);

    getGraphData(
      selectedId,
      selectedTypes.length > 0 ? selectedTypes : undefined,
      nodeLimit,
    )
      .then((data: GraphDataResponse) => {
        if (!cancelled) setGraphData(data);
      })
      .catch(() => {
        if (!cancelled) setGraphData(null);
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedTypes, nodeLimit, exploringEntity]);

  // ---------------------------------------------------------------------------
  // Entity search: debounced fuzzy search as user types
  // ---------------------------------------------------------------------------

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!value.trim() || !selectedId) {
      setSearchOptions([]);
      return;
    }

    setSearchLoading(true);
    searchTimerRef.current = setTimeout(() => {
      searchEntities(selectedId, value.trim())
        .then((results: Array<{ name: string; type: string }>) => {
          setSearchOptions(
            results.map((r) => ({
              value: r.name,
              label: (
                <Space>
                  <span>{r.name}</span>
                  <Tag color="blue" style={{ fontSize: 11 }}>{r.type}</Tag>
                </Space>
              ),
            })),
          );
        })
        .catch(() => setSearchOptions([]))
        .finally(() => setSearchLoading(false));
    }, 300);
  };

  const handleExploreEntity = (entityName: string) => {
    if (!selectedId || !entityName) return;
    setExploringEntity(entityName);
    setSearchQuery(entityName);
    setSearchOptions([]);
  };

  const handleBackToFullGraph = () => {
    setExploringEntity(null);
    setSearchQuery('');
  };

  // ---------------------------------------------------------------------------
  // Load neighborhood subgraph when exploring an entity
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!exploringEntity || !selectedId) return;

    let cancelled = false;
    setGraphLoading(true);

    getEntityNeighborhood(selectedId, exploringEntity, 1)
      .then((data: GraphDataResponse) => {
        if (!cancelled) setGraphData(data);
      })
      .catch(() => {
        if (!cancelled) setGraphData(null);
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [exploringEntity, selectedId]);

  // ---------------------------------------------------------------------------
  // Initialize / update vis-network whenever graphData changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current || !graphData) return;

    // Tear down previous instance
    networkRef.current?.destroy();
    networkRef.current = null;

    if (graphData.nodes.length === 0) return;

    // vis-data/vis-network have strict generic types; use 'any' casts
    // to satisfy the compiler while providing correct runtime data.
    const nodes = new DataSet(
      graphData.nodes.map((n) => {
        const isRoot = exploringEntity && n.id === exploringEntity;
        return {
          id: n.id,
          label: n.label,
          title: `${n.type}\n${n.description}`,
          color: isRoot
            ? { background: '#ff6b00', border: '#ff4500', highlight: { background: '#ff8c00', border: '#ff4500' } }
            : { background: n.color, border: n.color },
          size: isRoot ? n.size * 1.5 : n.size,
          shape: isRoot ? 'star' : 'dot',
          font: isRoot ? { color: '#ffffff', size: 16, bold: true } : undefined,
          borderWidth: isRoot ? 4 : 2,
        };
      }) as any,
    );

    const edges = new DataSet(
      graphData.edges.map((e, idx) => ({
        id: `edge-${e.from}-${e.to}-${idx}`,
        from: e.from,
        to: e.to,
        label: '',
        weight: e.weight,
        title: e.label || '点击查看详情',
        color: { color: '#555555' },
        width: Math.max(1, e.weight / 3),
      })) as any,
    );

    const options: Options = {
      height: '650px',
      physics: {
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 150,
          springConstant: 0.08,
          damping: 0.4,
        },
        maxVelocity: 50,
        solver: 'forceAtlas2Based',
        timestep: 0.35,
        stabilization: { iterations: 150 },
      },
      interaction: {
        hover: true,
        navigationButtons: true,
        zoomView: true,
        dragView: true,
      },
      nodes: {
        shape: 'dot',
        font: { color: '#e0e0e0', size: 14 },
        borderWidth: 2,
      },
      edges: {
        smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
        hoverWidth: 3,
        selectionWidth: 4,
      },
    };

    networkRef.current = new Network(
      containerRef.current,
      { nodes, edges } as any,
      options,
    );

    // Click handler — open drawer with node or edge detail
    networkRef.current.on('click', (params) => {
      // Check if edge was clicked
      if (params.edges.length > 0) {
        const edgeId = params.edges[0];
        const edgeIndex = graphData.edges.findIndex((_, idx) =>
          `edge-${graphData.edges[idx].from}-${graphData.edges[idx].to}-${idx}` === edgeId
        );

        if (edgeIndex !== -1) {
          const edge = graphData.edges[edgeIndex];
          const fromNode = graphData.nodes.find(n => n.id === edge.from);
          const toNode = graphData.nodes.find(n => n.id === edge.to);

          setSelectedEdge({
            id: edgeId,
            from: edge.from,
            to: edge.to,
            label: edge.label,
            weight: edge.weight,
            fromNode,
            toNode,
          });
          setSelectedNode(null);
          setDrawerType('edge');
          setDrawerOpen(true);
          return;
        }
      }

      // Check if node was clicked
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = graphData.nodes.find((n) => n.id === nodeId);
        if (node) {
          setSelectedNode({
            id: node.id,
            label: node.label,
            type: node.type,
            description: node.description,
            color: node.color,
          });
          setSelectedEdge(null);
          setDrawerType('node');
          setDrawerOpen(true);
        }
      }
    });

    return () => {
      networkRef.current?.destroy();
      networkRef.current = null;
    };
  }, [graphData, exploringEntity]);

  // ---------------------------------------------------------------------------
  // Type filter options derived from stats
  // ---------------------------------------------------------------------------

  const typeOptions = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.entity_types).map(([type, count]) => ({
      label: `${type} (${count})`,
      value: type,
    }));
  }, [stats]);

  // ---------------------------------------------------------------------------
  // Render: loading fallback
  // ---------------------------------------------------------------------------

  if (datasets.length === 0 && statsLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 100 }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ margin: -24, height: 'calc(100vh - 64px)' }}>
      <Layout style={{ height: '100%' }}>
        {/* ── Left sidebar: filters & stats ─────────────────────────── */}
        <Sider
          width={300}
          theme="light"
          style={{
            padding: '16px',
            overflowY: 'auto',
            borderRight: '1px solid #f0f0f0',
          }}
        >
          <Title level={4} style={{ marginBottom: 20 }}>
            <NodeIndexOutlined style={{ marginRight: 8 }} />
            图谱控制面板
          </Title>

          {/* Usage tip */}
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#e6f4ff',
              borderRadius: 6,
              fontSize: 12,
              color: '#1677ff',
            }}
          >
            <InfoCircleOutlined style={{ marginRight: 4 }} />
            提示：悬停连线查看关系描述，点击连线查看详情
          </div>

          {/* Dataset selector */}
          <div style={{ marginBottom: 20 }}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              数据集
            </Text>
            <Select
              style={{ width: '100%' }}
              placeholder="选择数据集"
              value={selectedId ?? undefined}
              onChange={(val) => selectDataset(val ?? null)}
              options={datasets.map((d) => ({
                label: `${d.name}${d.has_index ? '' : ' (未索引)'}`,
                value: d.id,
              }))}
              allowClear
              showSearch
              filterOption={(input, option) =>
                (option?.label as string)
                  ?.toLowerCase()
                  .includes(input.toLowerCase()) ?? false
              }
            />
          </div>

          {/* Empty state inside sidebar when no dataset selected */}
          {!selectedId && (
            <Empty
              description="请先选择数据集"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ marginTop: 60 }}
            />
          )}

          {selectedId && (
            <>
              {/* Type filter */}
              <div style={{ marginBottom: 20 }}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>
                  实体类型筛选
                </Text>
                <Select
                  mode="multiple"
                  style={{ width: '100%' }}
                  placeholder="全部类型"
                  value={selectedTypes}
                  onChange={setSelectedTypes}
                  options={typeOptions}
                  loading={statsLoading}
                  allowClear
                  maxTagCount="responsive"
                  disabled={!!exploringEntity}
                />
              </div>

              {/* Entity search / explore */}
              <div style={{ marginBottom: 20 }}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>
                  <SearchOutlined style={{ marginRight: 4 }} />
                  实体查找
                </Text>
                <AutoComplete
                  style={{ width: '100%' }}
                  options={searchOptions}
                  onSearch={handleSearchChange}
                  onSelect={handleExploreEntity}
                  value={searchQuery}
                  disabled={!selectedId}
                >
                  <Input
                    placeholder="输入实体名称模糊搜索..."
                    prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                    allowClear
                    suffix={searchLoading ? <Spin size="small" /> : undefined}
                  />
                </AutoComplete>
                {exploringEntity && (
                  <div style={{ marginTop: 8 }}>
                    <Tag
                      closable
                      color="orange"
                      onClose={handleBackToFullGraph}
                      style={{ fontSize: 13, padding: '4px 8px' }}
                    >
                      探索: {exploringEntity} (1层关系)
                    </Tag>
                    <Button
                      type="link"
                      size="small"
                      icon={<ArrowLeftOutlined />}
                      onClick={handleBackToFullGraph}
                      style={{ padding: 0, fontSize: 12 }}
                    >
                      返回全图
                    </Button>
                  </div>
                )}
              </div>

              {/* Node limit */}
              <div style={{ marginBottom: 20 }}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>
                  节点数量限制: {nodeLimit}
                </Text>
                <Slider
                  min={10}
                  max={500}
                  step={10}
                  value={nodeLimit}
                  onChange={setNodeLimit}
                  marks={{ 10: '10', 250: '250', 500: '500' }}
                  disabled={!!exploringEntity}
                />
              </div>

              {/* Refresh */}
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  if (exploringEntity) {
                    // Re-explore the same entity
                    setExploringEntity(null);
                    setTimeout(() => setExploringEntity(searchQuery), 50);
                  } else {
                    setSelectedTypes([...selectedTypes]);
                  }
                }}
                loading={graphLoading}
                block
                style={{ marginBottom: 20 }}
              >
                刷新图谱
              </Button>

              <Divider style={{ margin: '12px 0' }} />

              {/* Graph statistics */}
              {stats && (
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 10 }}>
                    <InfoCircleOutlined style={{ marginRight: 4 }} />
                    图谱统计
                  </Text>
                  <Space direction="vertical" style={{ width: '100%' }} size={6}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '4px 8px',
                        background: '#fafafa',
                        borderRadius: 4,
                      }}
                    >
                      <Text>实体总数</Text>
                      <Text strong>{stats.entity_count}</Text>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '4px 8px',
                        background: '#fafafa',
                        borderRadius: 4,
                      }}
                    >
                      <Text>关系总数</Text>
                      <Text strong>{stats.relationship_count}</Text>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '4px 8px',
                        background: '#fafafa',
                        borderRadius: 4,
                      }}
                    >
                      <Text>社区总数</Text>
                      <Text strong>{stats.community_count}</Text>
                    </div>
                  </Space>

                  {/* Type distribution */}
                  {Object.keys(stats.entity_types).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <Text strong style={{ display: 'block', marginBottom: 8 }}>
                        类型分布
                      </Text>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {Object.entries(stats.entity_types).map(([type, count]) => (
                          <Tag key={type} color="blue">
                            {type}: {count}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Sider>

        {/* ── Graph canvas ──────────────────────────────────────────── */}
        <Content style={{ position: 'relative', overflow: 'hidden' }}>
          {!selectedId ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                background: '#1a1a2e',
              }}
            >
              <Empty
                description={
                  <Text style={{ color: '#888' }}>请选择数据集以查看知识图谱</Text>
                }
                image={<ApartmentOutlined style={{ fontSize: 80, color: '#444' }} />}
              />
            </div>
          ) : graphData && graphData.nodes.length === 0 && !graphLoading ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                background: '#1a1a2e',
              }}
            >
              <Empty
                description={
                  <Text style={{ color: '#888' }}>
                    暂无图谱数据，请先完成索引
                  </Text>
                }
                image={<ClusterOutlined style={{ fontSize: 80, color: '#444' }} />}
              />
            </div>
          ) : (
            <Spin spinning={graphLoading} tip="加载图谱数据..." size="large">
              <div
                ref={containerRef}
                style={{
                  width: '100%',
                  height: '100%',
                  minHeight: 650,
                  background: '#1a1a2e',
                }}
              />
            </Spin>
          )}
        </Content>
      </Layout>

      {/* ── Node/Edge detail drawer ──────────────────────────────────────── */}
      <Drawer
        title={drawerType === 'node' ? '节点详情' : '关系详情'}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setSelectedNode(null);
          setSelectedEdge(null);
        }}
        width={420}
        destroyOnClose
      >
        {/* Edge detail */}
        {drawerType === 'edge' && selectedEdge && (
          <div>
            {/* Relationship info */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: 12,
                  padding: '12px',
                  background: '#fff7e6',
                  borderRadius: 6,
                  border: '1px solid #ffd591',
                }}
              >
                <LinkOutlined style={{ fontSize: 20, color: '#fa8c16', marginRight: 12 }} />
                <div style={{ flex: 1 }}>
                  <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 4 }}>
                    关系描述
                  </Text>
                  <Text style={{ fontSize: 13, color: '#595959' }}>
                    {selectedEdge.label || '暂无描述'}
                  </Text>
                </div>
              </div>

              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="关系强度">
                  <Tag color="orange" style={{ fontSize: 14, padding: '2px 10px' }}>
                    {selectedEdge.weight.toFixed(1)}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="起始实体">
                  {selectedEdge.fromNode ? (
                    <Space>
                      <Tag color={selectedEdge.fromNode.color} style={{ fontSize: 13 }}>
                        {selectedEdge.fromNode.type}
                      </Tag>
                      <Text strong>{selectedEdge.fromNode.label}</Text>
                    </Space>
                  ) : (
                    <Text>{selectedEdge.from}</Text>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="目标实体">
                  {selectedEdge.toNode ? (
                    <Space>
                      <Tag color={selectedEdge.toNode.color} style={{ fontSize: 13 }}>
                        {selectedEdge.toNode.type}
                      </Tag>
                      <Text strong>{selectedEdge.toNode.label}</Text>
                    </Space>
                  ) : (
                    <Text>{selectedEdge.to}</Text>
                  )}
                </Descriptions.Item>
              </Descriptions>
            </div>

            <Divider />

            {/* Entity details */}
            <Title level={5}>
              <InfoCircleOutlined style={{ marginRight: 6 }} />
              关联实体详情
            </Title>

            {selectedEdge.fromNode && (
              <div style={{ marginBottom: 16 }}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>
                  起始实体: {selectedEdge.fromNode.label}
                </Text>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="类型">
                    <Tag color={selectedEdge.fromNode.color}>{selectedEdge.fromNode.type}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="描述">
                    <Text type="secondary" ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>
                      {selectedEdge.fromNode.description || '暂无描述'}
                    </Text>
                  </Descriptions.Item>
                </Descriptions>
              </div>
            )}

            {selectedEdge.toNode && (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>
                  目标实体: {selectedEdge.toNode.label}
                </Text>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="类型">
                    <Tag color={selectedEdge.toNode.color}>{selectedEdge.toNode.type}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="描述">
                    <Text type="secondary" ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>
                      {selectedEdge.toNode.description || '暂无描述'}
                    </Text>
                  </Descriptions.Item>
                </Descriptions>
              </div>
            )}
          </div>
        )}

        {/* Node detail */}
        {drawerType === 'node' && selectedNode && (
          <div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="实体名称">
                <Text strong>{selectedNode.label}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="实体类型">
                <Tag
                  color={selectedNode.color}
                  style={{ fontSize: 14, padding: '2px 10px' }}
                >
                  {selectedNode.type}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="描述">
                <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {selectedNode.description || '暂无描述'}
                </Paragraph>
              </Descriptions.Item>
            </Descriptions>
          </div>
        )}
      </Drawer>
    </div>
  );
}
